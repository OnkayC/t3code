import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const turnColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_turns)
  `;

  if (!threadColumns.some((column) => column.name === "workflow")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN workflow TEXT
    `;
  }
  yield* sql`
      UPDATE projection_threads
      SET workflow = (
        SELECT json_extract(event.payload_json, '$.workflow')
        FROM orchestration_events AS event
        WHERE event.stream_id = projection_threads.thread_id
          AND event.event_type IN ('thread.created', 'thread.interaction-mode-set')
          AND json_type(event.payload_json, '$.workflow') = 'text'
        ORDER BY event.sequence DESC
        LIMIT 1
      )
      WHERE workflow IS NULL
    `;

  if (!turnColumns.some((column) => column.name === "workflow")) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN workflow TEXT
    `;
  }
  yield* sql`
      UPDATE projection_turns
      SET workflow = (
        SELECT json_extract(event.payload_json, '$.workflow')
        FROM orchestration_events AS event
        WHERE event.stream_id = projection_turns.thread_id
          AND event.event_type = 'thread.turn-start-requested'
          AND json_extract(event.payload_json, '$.messageId') = projection_turns.pending_message_id
          AND json_type(event.payload_json, '$.workflow') = 'text'
        ORDER BY event.sequence DESC
        LIMIT 1
      )
      WHERE workflow IS NULL
        AND pending_message_id IS NOT NULL
    `;
});
