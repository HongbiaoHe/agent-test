# Web e2e（Playwright）

The frontend's end-to-end tests run against the **already running** local frontend and backend.
There is no `webServer` in the config.

## Before you run

1. Start both servers with preview (configs live in `.claude/launch.json`):
   - `frontend` → http://localhost:3100
   - `backend` → http://localhost:3101 (the frontend proxies `/api-backend/*` to it)
2. Docker must have Redis (`agent-test-redis-1`) and MySQL running. Login clears the
   verification-code rate limit through `docker exec agent-test-redis-1 redis-cli DEL …`.
3. The backend must run **without** `RESEND_API_KEY`, which is test mode. `/auth/send-code` then
   returns the code and the login page fills it in.
4. Use Node 22: `export PATH=$HOME/.nvm/versions/node/v22.21.1/bin:$PATH`.

Tests use the local Google Chrome (`channel: "chrome"`). Do not run `playwright install`.

## Run

```bash
cd apps/frontend
pnpm e2e                          # all specs
pnpm e2e e2e/modes.spec.ts        # one file
pnpm e2e -g "switch modes"        # by title
```

| Env var | Default | Meaning |
| --- | --- | --- |
| `WEB_E2E_BASE_URL` | `http://localhost:3100` | frontend origin |
| `WEB_E2E_REDIS_CONTAINER` | `agent-test-redis-1` | Redis container for the rate-limit reset |

Tests run serially (`workers: 1`). On failure, the trace is kept in `test-results/`; open it with
`npx playwright show-trace <zip>`. The `e2e/.auth/`, `test-results/` and `playwright-report/`
folders are gitignored.

## Add a spec

- Create `e2e/<area>.spec.ts`. Put area-only helpers in `e2e/helpers/<area>.ts`. **Don't edit
  `helpers.ts`, `playwright.config.ts` or other areas' files.**
- Each spec logs in with **its own** test email. Call this once at the top level of the file:

  ```ts
  import { loggedInAs } from "./helpers";
  loggedInAs("e2e-web-<area>@example.test");
  ```

  It logs in once in `beforeAll` (clear rate limit → send code → sign in). It saves the session to
  `e2e/.auth/<email>.json`, and every test in the file starts from that session. To log in inside a
  test instead, use `loginAs(page, email)`.
- **Test email naming:** `e2e-web-<area>@example.test`, for example `e2e-web-modes@example.test`
  or `e2e-web-canvas@example.test`. The account is created on first login and is isolated from
  other areas' data.
- Every test sets up its own preconditions and cleans up after itself in `afterEach`, through the
  API.
- Prefer role/label locators. Adding a `data-testid` is fine, but don't change behavior.

### Shared helpers (`e2e/helpers.ts`)

| Helper | Purpose |
| --- | --- |
| `loggedInAs(email)` | file-level login, with per-email storageState |
| `loginAs(page, email)` | full email-code login inside a page |
| `authFile(email)` | path of that email's storageState |
| `api(page, path, { method, body })` | call the backend via `/api-backend` as the logged-in user. Returns `{ status, code, message, data }` and does not assert |
| `apiOk(page, path, init)` | same, but asserts `code === 0` and returns `data` |
| `getConversation(page, id)` | `GET /conversations/:id`, which includes `messages`, `status`, `modeId` and `model` |
| `waitConversationIdle(page, id, timeoutMs)` | poll `status` until it is no longer `running`/`queued` |
| `deleteConversation(page, id)` | cleanup; also stops a running conversation |
| `assistantText(conv)` | all assistant message contents as one string |
| `conversationIdFromUrl(page)` | id from `/agent/<id>` |
| `uniqueTag()` | random 8-character tag for names and model reply markers |

Tests that hit the real model (they send messages and wait for the turn to end) use the backend's
own keys. Give them a longer `test.setTimeout`, and make the assertions robust to model wording.
