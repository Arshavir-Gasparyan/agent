/**
 * Linear webhook -> GitHub repository_dispatch relay.
 *
 * Linear cannot send the Authorization header GitHub's dispatch API requires,
 * so this function sits in between: it verifies Linear's signature, decides
 * whether the issue actually crossed the trigger condition, and forwards a
 * compact payload to GitHub.
 *
 * Runs on the Edge runtime so the raw request body stays available for HMAC
 * verification (the Node runtime parses it before the handler sees it).
 */

export const config = { runtime: "edge" };

const DISPATCH_EVENT = "linear-issue";

/** Linear signs the raw body with HMAC-SHA256 and sends it hex-encoded. */
async function isSignatureValid(raw: string, signature: string, secret: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(raw));
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type LinearLabel = { id: string; name: string };
type LinearState = { id: string; name: string; type: string };

type LinearIssueEvent = {
  action: "create" | "update" | "remove";
  type: string;
  webhookTimestamp?: number;
  data?: {
    id: string;
    identifier: string;
    title: string;
    description?: string;
    url: string;
    branchName?: string;
    priorityLabel?: string;
    labels?: LinearLabel[];
    state?: LinearState;
  };
  updatedFrom?: Record<string, unknown>;
};

/**
 * Fire only on the transition into the trigger state, not on every later edit
 * to an issue that already sits there — otherwise renaming a ticket or leaving
 * a comment would queue another agent run.
 */
function shouldTrigger(event: LinearIssueEvent, label: string, state: string) {
  if (event.type !== "Issue") return false;
  if (event.action !== "create" && event.action !== "update") return false;

  const data = event.data;
  if (!data) return false;
  if (!data.labels?.some((l) => l.name.toLowerCase() === label.toLowerCase())) return false;
  if (data.state?.name.toLowerCase() !== state.toLowerCase()) return false;

  if (event.action === "create") return true;

  const changed = event.updatedFrom ?? {};
  return "stateId" in changed || "labelIds" in changed;
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let secret: string, token: string, repo: string;
  try {
    secret = requireEnv("LINEAR_WEBHOOK_SECRET");
    token = requireEnv("GITHUB_DISPATCH_TOKEN");
    repo = requireEnv("GITHUB_REPO"); // "owner/name"
  } catch (err) {
    console.error(err);
    return new Response("Server misconfigured", { status: 500 });
  }

  const raw = await req.text();
  const signature = req.headers.get("linear-signature") ?? "";
  if (!signature || !(await isSignatureValid(raw, signature, secret))) {
    return new Response("Invalid signature", { status: 401 });
  }

  let event: LinearIssueEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response("Malformed JSON", { status: 400 });
  }

  // Reject replays of an old, validly-signed delivery.
  if (event.webhookTimestamp && Date.now() - event.webhookTimestamp > 60_000) {
    return new Response("Stale delivery", { status: 400 });
  }

  const triggerLabel = process.env.LINEAR_TRIGGER_LABEL ?? "ai-agent";
  const triggerState = process.env.LINEAR_TRIGGER_STATE ?? "In Progress";

  if (!shouldTrigger(event, triggerLabel, triggerState)) {
    // 200 so Linear does not retry an event we deliberately ignored.
    return new Response(JSON.stringify({ dispatched: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const issue = event.data!;
  const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({
      event_type: DISPATCH_EVENT,
      client_payload: {
        identifier: issue.identifier,
        title: issue.title,
        // Keep well under GitHub's client_payload size ceiling.
        description: (issue.description ?? "").slice(0, 6000),
        url: issue.url,
        branchName: issue.branchName ?? `agent/${issue.identifier.toLowerCase()}`,
        priority: issue.priorityLabel ?? "None",
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`GitHub dispatch failed: ${res.status} ${body}`);
    // 5xx so Linear retries a transient GitHub failure.
    return new Response("Dispatch failed", { status: 502 });
  }

  console.log(`Dispatched ${issue.identifier} to ${repo}`);
  return new Response(JSON.stringify({ dispatched: true, issue: issue.identifier }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
