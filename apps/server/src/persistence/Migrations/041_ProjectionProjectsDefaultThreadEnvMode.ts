import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import Migration0039 from "./039_ProjectionWorkflowColumns.ts";

export default Effect.gen(function* () {
  // Upstream previously shipped this migration as 039. Databases that ran
  // that history skip our 039, so repair the workflow columns here as well.
  yield* Migration0039;

  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (!columns.some((column) => column.name === "default_thread_env_mode")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN default_thread_env_mode TEXT
    `;
  }
});
