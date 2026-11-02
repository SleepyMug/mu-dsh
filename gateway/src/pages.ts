// The few HTML pages the gateway renders itself.

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function layout(title: string, body: string, head = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${head}
<style>
  body { font: 15px/1.5 system-ui, sans-serif; background: #f4f5f7; color: #1d2330; margin: 0; }
  main { max-width: 22rem; margin: 12vh auto; background: #fff; padding: 2rem; border-radius: 10px;
         box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  h1 { font-size: 1.25rem; margin: 0 0 1.25rem; }
  label { display: block; margin: .75rem 0 .25rem; font-weight: 600; }
  input { width: 100%; box-sizing: border-box; padding: .5rem; font: inherit; border: 1px solid #c4c8d0; border-radius: 6px; }
  button { margin-top: 1.25rem; width: 100%; padding: .6rem; font: inherit; font-weight: 600; color: #fff;
           background: #3657d6; border: 0; border-radius: 6px; cursor: pointer; }
  .error { color: #b3261e; margin: 0 0 .5rem; }
  .ok { color: #1e7b34; margin: 0 0 .5rem; }
  nav a { display: block; margin: .5rem 0; padding: .6rem; text-align: center; border: 1px solid #c4c8d0;
          border-radius: 6px; color: inherit; text-decoration: none; font-weight: 600; }
  nav a.primary { background: #3657d6; border-color: #3657d6; color: #fff; }
  .muted { color: #5b6270; }
  pre.problem { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; background: #f4f5f7;
                padding: .6rem; border-radius: 6px; max-height: 18rem; overflow: auto; }
</style>
</head>
<body><main>${body}</main></body>
</html>
`
}

export function loginPage(options: { error?: string; next?: string; username?: string } = {}): string {
  const error = options.error ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>` : ''
  const next = options.next ? `<input type="hidden" name="next" value="${escapeHtml(options.next)}">` : ''
  return layout(
    'Sign in · DeepSeek Harness',
    `<h1>Sign in to DeepSeek Harness</h1>
${error}<form method="post" action="/login">
${next}<label for="username">User name</label>
<input id="username" name="username" autocomplete="username" required value="${escapeHtml(options.username ?? '')}" autofocus>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button>
</form>`,
  )
}

export function startingPage(user: string, error: string | null): string {
  const detail = error
    ? `<p class="muted">It stopped last time. If the problem is in your own configuration, fix it from a shell
(for example <code>~/.dsh/profiles/web/cordis.patch.yml</code>); dsh is retried automatically.</p>
<pre class="problem">${escapeHtml(error)}</pre>`
    : ''
  return layout(
    'Starting · DeepSeek Harness',
    `<h1>Starting your workspace…</h1>
<p>dsh for <b>${escapeHtml(user)}</b> is starting. This page reloads automatically.</p>
${detail}<form method="post" action="/logout"><button type="submit">Sign out</button></form>`,
    '<meta http-equiv="refresh" content="2">',
  )
}

export function messagePage(title: string, message: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/">Home</a></p>`)
}

export function portalPage(user: string, notice?: string): string {
  const message = notice ? `<p class="ok" role="status">${escapeHtml(notice)}</p>` : ''
  return layout(
    'DeepSeek Harness',
    `<h1>Hello, ${escapeHtml(user)}</h1>
${message}<nav>
<a class="primary" href="/u/${escapeHtml(user)}/">Open DeepSeek Harness</a>
<a href="/account/password">Change password</a>
</nav>
<form method="post" action="/logout"><button type="submit">Sign out</button></form>`,
  )
}

export function passwordPage(user: string, error?: string): string {
  const message = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''
  return layout(
    'Change password · DeepSeek Harness',
    `<h1>Change password</h1>
<p class="muted">This is the password of your account <b>${escapeHtml(user)}</b> on this machine, for signing in here and to the shell alike.</p>
${message}<form method="post" action="/account/password">
<label for="current">Current password</label>
<input id="current" name="current" type="password" autocomplete="current-password" required autofocus>
<label for="new">New password</label>
<input id="new" name="new" type="password" autocomplete="new-password" required>
<label for="repeat">Repeat new password</label>
<input id="repeat" name="repeat" type="password" autocomplete="new-password" required>
<button type="submit">Change password</button>
</form>
<p><a href="/">Back</a></p>`,
  )
}
