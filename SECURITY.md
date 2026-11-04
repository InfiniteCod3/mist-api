# Security policy

## Report a vulnerability

Report a vulnerability privately through GitHub. On the repository's Security tab, choose **Report a vulnerability**. This opens a private security advisory that only you and the repository's administrators can read.

Don't open a public issue for a vulnerability. Include the mist-api version, what an attacker can do, and the steps or code that show it.

## Scope

These are in scope:

- The page side (`@aurologic/mist-api`): the debug handle and capability, the page registry, masking of recorded values, and `mist.events`.
- The native side (`@aurologic/mist-api/native`): the debug gate, the native records, and the event channel.
- The bus (`@aurologic/mist-api/bus`), the stores and util helpers.
- The `mist` CLI.

A report is in scope when page code can get past what [docs/security.md](docs/security.md) says it can't do: reach a plugin's capability or native side, see a value that should be masked or reduced, or open the gate without a debugging port.

The limits that docs/security.md lists are known and out of scope. For example, a stopped plugin's handle can be replaced, and anyone with the debugging port controls Discord. A report that removes one of those limits is welcome.

Vulnerabilities in Evi or Discord themselves belong to those projects.

## Supported versions

Only the latest 0.x release gets security fixes.
