import { createAccountRepository } from "../accounts/accountRepository.js";
import { createAccountService } from "../accounts/accountService.js";
import { createBangumiSummaryRepository } from "../bangumi/bangumiSummaryRepository.js";
import { createAccountAuthMiddleware } from "../routes/accountAuth.js";
import { createSyncMergeService } from "../sync/syncMergeService.js";
import { createSyncRepository } from "../sync/syncRepository.js";
import { createSyncSnapshotService } from "../sync/syncSnapshotService.js";

export function createAccountSyncRuntime({
  sqlite,
  metadataEnsureService,
  clock = () => new Date(),
  logger = {},
}) {
  const ensureMetadata = metadataEnsureService?.ensure ?? (() => {});
  const accountRepository = createAccountRepository({ sqlite, clock });
  const accountService = createAccountService({ repository: accountRepository, clock });
  const syncRepository = createSyncRepository({ sqlite, clock });
  const summaryRepository = createBangumiSummaryRepository(sqlite);
  const syncSnapshotService = createSyncSnapshotService({
    syncRepository,
    summaryRepository,
    ensureMetadata,
    clock,
    logger,
  });
  const syncMergeService = createSyncMergeService({
    repository: syncRepository,
    ensureMetadata,
    snapshotService: syncSnapshotService,
    clock,
    logger,
  });
  const authenticate = createAccountAuthMiddleware({ accountService, logger });

  return {
    accountService,
    authenticate,
    syncMergeService,
    syncSnapshotService,
  };
}
