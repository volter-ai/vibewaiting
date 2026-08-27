# almostnode Three.js HMR spike

This experiment runs a small Three.js project from almostnode's `VirtualFS`, serves it
through almostnode's browser-side Vite-compatible server, and changes the running source
file on demand to exercise its HMR path.

Run it from the repository root:

```sh
npm run dev:almostnode
```

Open <http://127.0.0.1:4173>, wait for **Runtime: Ready**, and use **Change source
file**. A successful HMR update changes the cube into a pink torus knot without replacing
the preview iframe. **Iframe loads** should remain at `1` while the rendered revision
changes.

This is currently a development-only spike. In `0.2.14`, production bundling the public
package barrel with Vite 7 attempts to rebundle an optional worker asset from the wrong
path. That is an upstream packaging issue rather than a runtime or HMR requirement, but it
must be resolved before this can become a deployable application surface.

This is a capability spike, not a production security boundary. The iframe currently
uses same-origin mode so almostnode's root-scoped service worker can route virtual-server
requests. Generated user code must eventually move to a separately hosted sandbox origin.
