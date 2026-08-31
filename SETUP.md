# Linear → Claude Code → GitHub → Vercel

Move a labelled Linear issue into **In Progress** and a PR appears on `dev`,
merges itself if CI is green, and deploys.

```
Linear issue (label ai-agent + state In Progress)
   │  webhook, HMAC-signed
   ▼
api/linear-webhook.ts        (Vercel Edge function)
   │  repository_dispatch: linear-issue
   ▼
.github/workflows/linear-agent.yml
   │  Claude Code edits the tree → PR to dev → auto-merge
   ▼
.github/workflows/ci.yml     (tsc, lint, build — the gate)
   │  merged
   ▼
Vercel deploys dev
```

## 1. GitHub

```bash
git add -A && git commit -m "Add Linear agent pipeline"
# create the repo on github.com, then:
git remote add origin git@github.com:<owner>/<repo>.git
git push -u origin main
git switch -c dev && git push -u origin dev
```

**Settings → General:** enable *Allow auto-merge*.

**Settings → Branches:** protect `dev`, require the `verify` status check.
Without this, auto-merge merges instantly and the CI gate does nothing.

**Settings → Actions → General:** set Workflow permissions to
*Read and write*, and allow Actions to create pull requests.

**Secrets** (Settings → Secrets and variables → Actions):

| Secret | What |
|---|---|
| `ANTHROPIC_API_KEY` | From console.anthropic.com |
| `AGENT_PAT` | Fine-grained PAT, this repo, **Contents: RW**, **Pull requests: RW** |

`AGENT_PAT` is not optional. A PR opened with the default `GITHUB_TOKEN` does
not trigger `ci.yml`, so the required check never reports and auto-merge waits
forever.

## 2. Vercel

Import the repo. Vite is detected automatically; `vercel.json` pins the rest.

Set the env vars from `.env.example` under **Settings → Environment Variables**
(Production scope at minimum):

- `LINEAR_WEBHOOK_SECRET` — filled in at step 3
- `GITHUB_DISPATCH_TOKEN` — fine-grained PAT, this repo, **Contents: RW**
- `GITHUB_REPO` — `owner/repo`

Deploy. The relay is then live at
`https://<project>.vercel.app/api/linear-webhook`.

The relay is served from the **production** deployment (`main`), so the URL is
stable even while `dev` redeploys.

## 3. Linear

Create the label **`ai-agent`** in your team.

**Settings → API → Webhooks → New webhook:**

- URL: `https://<project>.vercel.app/api/linear-webhook`
- Resource types: **Issues** only
- Copy the signing secret into Vercel as `LINEAR_WEBHOOK_SECRET`, then redeploy

To change what triggers a run, set `LINEAR_TRIGGER_LABEL` /
`LINEAR_TRIGGER_STATE` in Vercel. The state name must match your workflow state
exactly (comparison is case-insensitive).

## 4. Test it

Skip Linear on the first run — GitHub → Actions → **Linear Agent** → *Run
workflow*, and fill in the fields by hand. Confirms the agent, PR, CI, and
auto-merge path works before webhooks are in the picture.

Then end to end: create an issue, label it `ai-agent`, drag it to In Progress.
Vercel → your project → Logs shows `Dispatched ENG-123 to owner/repo`.

## How the trigger avoids double-firing

The relay only dispatches when `stateId` or `labelIds` is in Linear's
`updatedFrom` — the fields that actually changed. Editing the title of an issue
already sitting in In Progress does not queue another run. Moving it out and
back in does.

## Failure modes worth knowing

| Symptom | Cause |
|---|---|
| Linear shows 401 | `LINEAR_WEBHOOK_SECRET` mismatch, or Vercel not redeployed after setting it |
| 200 `{"dispatched": false}` | Label or state name does not match the trigger |
| Dispatch 404 | `GITHUB_DISPATCH_TOKEN` lacks Contents: RW, or `GITHUB_REPO` is wrong |
| PR opens but never merges | `AGENT_PAT` missing, auto-merge disabled, or no required check set |
| "No changes produced" | Claude judged the issue too ambiguous — the description needs more detail |

## Scope note

Anything labelled `ai-agent` gets an autonomous code change merged to `dev` on
green CI. CI is currently typecheck + lint + build; there are **no tests**, so
nothing verifies behaviour. Add tests before pointing this at work that
matters, and keep the label off tickets you have not read.
