---
'@floating-ui/utils': patch
'@floating-ui/dom': patch
---

fix: position and clip against a `filter` or `backdrop-filter` containing block in Safari when the browser reports it as the element's `offsetParent`
