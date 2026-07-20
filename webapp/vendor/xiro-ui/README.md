Committed, renderable local stub for `xiro-ui`.

Replaces the previous `file:../modules/xiro-ui-0.0.1.tgz` dependency, which
pointed at an uncommitted tarball (broke `npm ci` from a clean clone) whose
components all returned `null` (blanked every route, breaking e2e).

This stub renders real DOM for the four exports the app actually imports —
`Main`, `Nav`, `Button`, `Modal` — passing through `children` and the props
used in `App.tsx` / `PDFView.tsx` / `SignatureCanvas.tsx`.

This is scaffolding, not a design decision: whether redsign adopts the real
internal component library / redstyle is still open (tracked separately).
Swapping this stub for the real package later only requires updating the
`xiro-ui` dependency in `webapp/package.json`.
