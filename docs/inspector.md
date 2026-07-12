# Inspector (devtools)

Source: `src/devtools/inspector.ts`. A zero-dependency in-game inspector overlay — pause/step the loop, browse and live-edit entity components as JSON, fire verbs through the validated pipeline, watch `actions.recent`. Toggle with **F2** (configurable).

```ts
import { attachInspector } from "llmgine/devtools";
const inspector = attachInspector({ world, actions, loop, renderer }); // renderer optional
inspector.open();      // or press F2; inspector.dispose() removes everything
```

**Alt+click** any canvas while the inspector is open to select the entity under the cursor (needs a `renderer` with `entityAt(x, y)`). Component edits merge onto the LIVE ref via Apply — dev-only, it bypasses the verb gate. Browser only: `attachInspector` throws headless, but importing the module is safe in Node.

![inspector screenshot placeholder](./img/inspector.png)
