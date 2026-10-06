// A real answer of GitHub to git's smart HTTP discovery, which is how the production build learns the default branch of the
// repository (server/productionMigrate.js):
//
//   GET https://github.com/MatanBaruch1988/building-qr-system.git/info/refs?service=git-upload-pack
//
// Captured on 06/10/2026 with curl (no credentials, a public repository, no Git-Protocol header, so it is protocol version 0)
// and trimmed after the second branch: the real answer goes on with the rest of the branches, the tags and one line for every
// pull request, 6881 bytes for this repository. Every line is as GitHub sent it, with its own length prefix (four hex digits
// that count themselves); tests/production-migrate.test.js checks that the prefixes still add up, so a trim that cut a line
// would be noticed. The `\0` after `HEAD` is the NUL byte that separates the first reference from the capabilities, and the
// capability `symref=HEAD:refs/heads/master` is what names the default branch. Nothing here is a secret: the object ids are
// commits of a public repository.
export const REAL_ADVERTISEMENT_LINES = [
  '001e# service=git-upload-pack\n',
  '0000',
  '015bcc558dec480aa21f02c94173f5107e4237f15413 HEAD\0multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done symref=HEAD:refs/heads/master filter object-format=sha1 agent=git/github-3404ba3431c7-Linux\n',
  '0049c17ba8df9fa3c6b0642fb654c35243b2b8c348db refs/heads/admin-tabbar-360\n',
  '003fcc558dec480aa21f02c94173f5107e4237f15413 refs/heads/master\n',
  '0000',
]

/** The trimmed real answer as one string. */
export const REAL_ADVERTISEMENT = REAL_ADVERTISEMENT_LINES.join('')
