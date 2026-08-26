// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { OmpSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeOmpTextGeneration } from "../../textGeneration/OmpTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOmpAdapter } from "../Layers/OmpAdapter.ts";
import { checkOmpProviderStatus, makePendingOmpProvider } from "../Layers/OmpProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const DRIVER_KIND = ProviderDriverKind.make("omp");
const decodeOmpSettings = Schema.decodeSync(OmpSettings);

export type OmpDriverEnv = BackgroundPolicy.BackgroundPolicy | ServerConfig | ServerSettingsService;

export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OMP",
    supportsMultipleInstances: true,
  },
  configSchema: OmpSettings,
  defaultConfig: (): OmpSettings => decodeOmpSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = { ...config, enabled } satisfies OmpSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const sessionRoot = NodePath.join(serverConfig.stateDir, "provider-sessions", instanceId);
      const probeOptions = {
        instanceId,
        sessionRoot,
        environment: processEnv,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
      };
      const maintenanceCapabilities = makeProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
        updateExecutable: effectiveConfig.binaryPath,
        updateArgs: ["update"],
        updateLockKey: `omp-update:${effectiveConfig.binaryPath}`,
      });

      const adapter = yield* makeOmpAdapter(effectiveConfig, {
        instanceId,
        sessionRoot,
        attachmentsDir: serverConfig.attachmentsDir,
        environment: processEnv,
      });
      const textGeneration = yield* makeOmpTextGeneration(
        effectiveConfig,
        processEnv,
        serverConfig.attachmentsDir,
      );
      const checkProvider = checkOmpProviderStatus(effectiveConfig, probeOptions);
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OmpSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () =>
          DateTime.now.pipe(
            Effect.map(DateTime.formatIso),
            Effect.map((checkedAt) =>
              makePendingOmpProvider(effectiveConfig, probeOptions, checkedAt),
            ),
          ),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build OMP snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
