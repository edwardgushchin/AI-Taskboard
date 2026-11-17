# Licensing review for T-0113

Reviewed baseline: `9dfcf5d083368af4783cd22792e358a1d93d60e2`.
This is a repository audit for manual review, not a legal title opinion.

## Authorization and existing grants

The card history records approval of unchanged PolyForm Noncommercial 1.0.0
with its organization exceptions (sequences 7–8) and the user's confirmation
of Eduard Gushchin and eduardgushchin@yandex.ru (sequences 9–10).

The reachable HEAD history has no root LICENSE/COPYING/NOTICE grant and no
license field or license grant found in the history of package.json/README.
The author identities found were Eduard Gushchin and two AI Taskboard local
identities. Those identities do not establish copyright ownership or assignment.
No contributor agreement or assignment document was found in tracked files.
Private permissions and untracked agreements cannot be checked from Git.
The owner should confirm any such obligations before publication. This change
does not revoke earlier grants or relicense third-party materials.

Reproduction commands:

```sh
git log HEAD --format='%an <%ae>'
git log HEAD --format='%h %s' -- LICENSE LICENSE.md LICENSE.txt COPYING NOTICE
git log HEAD -G '"license"|PolyForm|All rights reserved|MIT License|Apache License' -- package.json README.md
```

## Third-party scope

- Codicons 0.0.46-24 keeps its CC-BY-4.0 LICENSE and Microsoft attribution in
  `src/desktop/vendor/codicons/NOTICE.txt`, including the Git logo attribution
  already included in its LICENSE. The bundled font is recorded as unmodified.
- Codex Worklog keeps its MIT grant in `src/desktop/vendor/codex-worklog/LICENSE`.
  This is an existing permission, including commercial rights to that component.
- Runtime npm dependencies retain their upstream texts. The lockfile includes
  MIT, ISC, BSD, Apache-2.0, PSF-2.0, 0BSD and LGPL terms; they are not covered
  by the project's noncommercial restriction. Sharp's native libvips components
  include LGPL-3.0-or-later. Preserve their notices and applicable source,
  replacement and redistribution rights when preparing a public release.
- Electron and Chromium ship their own runtime notices. Standalone CLI builds
  copy the full license of the exact Node.js runtime version, including its
  bundled components, plus fflate's MIT license. CLI bundling currently imports
  fflate as its only external npm runtime package.
- The installed upstream `onnxruntime-common`, `onnxruntime-node` and
  `onnxruntime-web` packages declare MIT in package.json but do not include a
  root license file. No existing notice was removed. Before public release,
  resolve this upstream notice gap and review native library source obligations;
  preserving the supplied texts alone is not a complete compliance audit.
- Downloaded speech model weights are separate from the repository license;
  a release that includes weights must review that model's own terms.

## Verification scope

The release target documented in README is Windows x64. CLI and desktop
packaging checks for this card inspect the actual outputs, compare license
bytes, and check vendor and dependency notices. The compact run report is
attached to the card. No publication is part of this task. Linux/macOS native
installers and private historical permissions remain outside verified results.
