import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("043_RepairUpstreamMigrationCollisions", (it) => {
  it.effect("repairs schemas after the upstream 039 and 040 migration history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 38 });
      yield* sql`
        ALTER TABLE projection_projects
        ADD COLUMN default_thread_env_mode TEXT
      `;
      yield* sql`
        ALTER TABLE projection_projects
        ADD COLUMN favicon_path TEXT
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (39, 'ProjectionProjectsDefaultThreadEnvMode'),
          (40, 'ProjectionProjectFaviconPath')
      `;

      yield* runMigrations({ toMigrationInclusive: 43 });

      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const turnColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_turns)
      `;
      const projectColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.isTrue(threadColumns.some((column) => column.name === "workflow"));
      assert.isTrue(threadColumns.some((column) => column.name === "pending_plan_review_count"));
      assert.isTrue(turnColumns.some((column) => column.name === "workflow"));
      assert.isTrue(projectColumns.some((column) => column.name === "default_thread_env_mode"));
      assert.isTrue(projectColumns.some((column) => column.name === "favicon_path"));
    }),
  );
});
