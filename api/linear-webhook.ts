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
type TriggerCheck = { ok: boolean; reason: string };
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
    labelIds?: string[];
    state?: LinearState;
  };
  updatedFrom?: Record<string, unknown>;
};

/**
 * Fire only on the transition into the trigger state, not on every later edit
 * to an issue that already sits there — otherwise renaming a ticket or leaving
 * a comment would queue another agent run.
 *
 * Returns a reason on every path so the Vercel logs explain a declined
 * delivery instead of silently doing nothing.
 */
function shouldTrigger(
  event: LinearIssueEvent,
  label: string,
  state: string,
): TriggerCheck {
  if (event.type !== "Issue") {
    return { ok: false, reason: `type is "${event.type}", not "Issue"` };
  }
  if (event.action !== "create" && event.action !== "update") {
    return { ok: false, reason: `action is "${event.action}"` };
  }

  const data = event.data;
  if (!data) return { ok: false, reason: "payload had no data object" };

  const labelNames = data.labels?.map((l) => l.name) ?? [];
  if (!data.labels) {
    return {
      ok: false,
      reason:
        "payload has no `labels` array (saw labelIds: " +
        `${JSON.stringify(data.labelIds ?? null)}) — cannot match by name`,
    };
  }
  if (!labelNames.some((n) => n.toLowerCase() === label.toLowerCase())) {
    return {
      ok: false,
      reason: `labels ${JSON.stringify(labelNames)} do not include "${label}"`,
    };
  }

  const stateName = data.state?.name;
  if (stateName?.toLowerCase() !== state.toLowerCase()) {
    return {
      ok: false,
      reason: `state "${stateName}" is not "${state}"`,
    };
  }

  if (event.action === "create") return { ok: true, reason: "issue created in trigger state" };

  const changed = Object.keys(event.updatedFrom ?? {});
  if (changed.includes("stateId") || changed.includes("labelIds")) {
    return { ok: true, reason: `changed fields: ${JSON.stringify(changed)}` };
  }
  return {
    ok: false,
    reason: `already in trigger state; changed fields ${JSON.stringify(changed)} are not state/label`,
  };
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

  // `||` not `??`: an env var present-but-blank must fall back to the default,
  // otherwise the comparison silently matches nothing.
  const triggerLabel = process.env.LINEAR_TRIGGER_LABEL?.trim() || "ai-agent";
  const triggerState = process.env.LINEAR_TRIGGER_STATE?.trim() || "In Progress";

  const check = shouldTrigger(event, triggerLabel, triggerState);
  console.log(
    `[linear] ${event.type}/${event.action} ${event.data?.identifier ?? "?"} ` +
      `-> ${check.ok ? "DISPATCH" : "SKIP"}: ${check.reason}`,
  );

  if (!check.ok) {
    // 200 so Linear does not retry an event we deliberately ignored.
    return new Response(JSON.stringify({ dispatched: false, reason: check.reason }), {
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
