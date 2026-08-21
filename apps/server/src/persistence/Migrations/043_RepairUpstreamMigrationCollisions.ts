import * as Effect from "effect/Effect";

import Migration0039 from "./039_ProjectionWorkflowColumns.ts";
import Migration0040 from "./040_ProjectionPendingPlanReviewCount.ts";

export default Effect.gen(function* () {
  // Upstream previously used IDs 039 and 040 for the project environment and
  // favicon migrations. Databases from that history skip our migrations with
  // those IDs, so repair both idempotent schemas at a new monotonic boundary.
  yield* Migration0039;
  yield* Migration0040;
});
