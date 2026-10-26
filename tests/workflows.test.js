const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const workflows = path.join(__dirname, '..', '.github', 'workflows')
const read = (name) => fs.readFileSync(path.join(workflows, name), 'utf8')

describe('Workflows', () => {
  // The repo is a fork with no GitHub App: the release uses the built-in token,
  // which `permissions: contents: write` lets push the release commit and tag.
  it('releases with the built-in token, never a GitHub App one', () => {
    const cd = read('cd.yml')
    assert.doesNotMatch(cd, /create-github-app-token|CI_APP_ID|CI_APP_KEY|steps\.app-token/)
    assert.match(cd, /permissions:\s*\n\s*contents: write/)
  })

  // The tests gate CI; a coverage upload Codecov refuses (no token) does not.
  it('never fails CI on the Codecov upload', () => {
    const upload = read('ci.yml').split('Upload coverage to Codecov')[1].split('\n\n')[0]
    assert.match(upload, /fail_ci_if_error: false/)
    assert.match(upload, /token: \$\{\{ secrets\.CODECOV_TOKEN \}\}/)
  })
})
