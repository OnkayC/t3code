import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("039_ProjectionWorkflowColumns", (it) => {
  it.effect("backfills thread and turn workflows from already-projected events", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 38 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, created_at, updated_at
        ) VALUES (
          'thread-workflow-backfill',
          'project-workflow-backfill',
          'Workflow backfill',
          '{"provider":"omp","model":"fixture/model"}',
          '2026-02-26T10:00:00.000Z',
          '2026-02-26T10:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json
        ) VALUES (
          'thread-workflow-backfill',
          'turn-workflow-backfill',
          'message-workflow-backfill',
          'completed',
          '2026-02-26T10:00:02.000Z',
          '[]'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        ) VALUES
          (
            'event-workflow-created', 'thread', 'thread-workflow-backfill', 1,
            'thread.created', '2026-02-26T10:00:00.000Z', 'command-workflow-created',
            NULL, 'command-workflow-created', 'system',
            '{"threadId":"thread-workflow-backfill","workflow":"iterative"}', '{}'
          ),
          (
            'event-workflow-selected', 'thread', 'thread-workflow-backfill', 2,
            'thread.interaction-mode-set', '2026-02-26T10:00:01.000Z', 'command-workflow-selected',
            NULL, 'command-workflow-selected', 'system',
            '{"threadId":"thread-workflow-backfill","workflow":"parallel"}', '{}'
          ),
          (
            'event-turn-workflow', 'thread', 'thread-workflow-backfill', 3,
            'thread.turn-start-requested', '2026-02-26T10:00:02.000Z', 'command-turn-workflow',
            NULL, 'command-turn-workflow', 'system',
            '{"threadId":"thread-workflow-backfill","messageId":"message-workflow-backfill","workflow":"iterative"}', '{}'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 39 });

      const threads = yield* sql<{ readonly workflow: string | null }>`
        SELECT workflow FROM projection_threads WHERE thread_id = 'thread-workflow-backfill'
      `;
      const turns = yield* sql<{ readonly workflow: string | null }>`
        SELECT workflow FROM projection_turns WHERE turn_id = 'turn-workflow-backfill'
      `;
      assert.deepEqual(threads, [{ workflow: "parallel" }]);
      assert.deepEqual(turns, [{ workflow: "iterative" }]);
    }),
  );
});
