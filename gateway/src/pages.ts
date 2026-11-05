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
  form.inline button, a.button { margin-top: .5rem; }
  button.secondary, a.button { display: block; box-sizing: border-box; width: 100%; padding: .6rem; text-align: center;
           background: #fff; color: inherit; border: 1px solid #c4c8d0; border-radius: 6px; font-weight: 600;
           text-decoration: none; }
  .banner { background: #fff4ce; border: 1px solid #e0c060; border-radius: 6px; padding: .6rem; margin: 0 0 1rem; }
  h2 { font-size: 1rem; margin: 1.5rem 0 .25rem; }
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

export type Mode = 'normal' | 'recovery'

/** A button that posts one workspace action (see Gateway.workspace). */
function actionButton(action: string, label: string, primary = false): string {
  return `<form class="inline" method="post" action="/account/workspace"><input type="hidden" name="action" value="${action}">
<button type="submit"${primary ? '' : ' class="secondary"'}>${escapeHtml(label)}</button></form>`
}

const RECOVERY_BANNER = `<p class="banner" role="status"><b>Recovery mode.</b> Your own settings, plugins and
<code>~/.env</code> are not loaded. Changes made in dsh's Settings now are temporary and are discarded when you leave
recovery mode; fix your own files (for example <code>~/.dsh/profiles/web/cordis.patch.yml</code>) instead.</p>`

export function startingPage(user: string, error: string | null, mode: Mode = 'normal'): string {
  // Without an error the page refreshes itself until dsh is up; with one, the user chooses.
  const detail = error
    ? `<p class="muted">Your workspace stopped. It is retried automatically; if the problem is in your own
configuration, start in recovery mode to fix it, or reset your settings.</p>
<pre class="problem">${escapeHtml(error)}</pre>
${actionButton('restart', 'Retry now', true)}
${mode === 'recovery' ? '' : actionButton('recover', 'Start in recovery mode')}
<a class="button" href="/account/reset">Reset my settings…</a>`
    : '<p>This page reloads automatically.</p>'
  return layout(
    'Starting · DeepSeek Harness',
    `<h1>Starting your workspace…</h1>
${mode === 'recovery' ? RECOVERY_BANNER : ''}<p>dsh for <b>${escapeHtml(user)}</b> is ${error ? 'not running' : 'starting'}.</p>
${detail}<form method="post" action="/logout"><button type="submit" class="secondary">Sign out</button></form>`,
    error ? '<meta http-equiv="refresh" content="10">' : '<meta http-equiv="refresh" content="2">',
  )
}

export function messagePage(title: string, message: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/">Home</a></p>`)
}

export function portalPage(user: string, options: { notice?: string; mode?: Mode } = {}): string {
  const message = options.notice ? `<p class="ok" role="status">${escapeHtml(options.notice)}</p>` : ''
  const recovery = options.mode === 'recovery'
  return layout(
    'DeepSeek Harness',
    `<h1>Hello, ${escapeHtml(user)}</h1>
${recovery ? RECOVERY_BANNER : ''}${message}<nav>
<a class="primary" href="/u/${escapeHtml(user)}/">Open DeepSeek Harness</a>
<a href="/account/password">Change password</a>
</nav>
<h2>Workspace</h2>
<p class="muted">Restarting stops anything your agents are running.</p>
${recovery ? actionButton('restart', 'Leave recovery mode', true) : actionButton('restart', 'Restart workspace')}
${recovery ? '' : actionButton('recover', 'Start in recovery mode')}
<a class="button" href="/account/reset">Reset my settings…</a>
<form method="post" action="/logout"><button type="submit">Sign out</button></form>`,
  )
}

export function resetPage(user: string): string {
  return layout(
    'Reset settings · DeepSeek Harness',
    `<h1>Reset my settings</h1>
<p>This sets your dsh settings for <b>${escapeHtml(user)}</b> aside and restarts your workspace with the site defaults.</p>
<p class="muted">Your settings file <code>~/.dsh/profiles/web/cordis.patch.yml</code> is kept as
<code>cordis.patch.yml.bak-&lt;time&gt;</code>. Sessions, stored keys and installed plugins are not touched.
Running agents stop.</p>
${actionButton('reset', 'Reset and restart', true)}
<p><a href="/">Cancel</a></p>`,
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
