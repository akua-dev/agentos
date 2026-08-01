import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import {
  Clock,
  Crypto,
  Effect,
  Encoding,
  Schema,
} from "effect";

import type { CodexOAuthRefreshClient } from "./codex-oauth-effect.ts";
import {
  type AtomicJsonStore,
  type AtomicJsonStoreError,
  makeAtomicJsonStore,
} from "./effect-storage.ts";

const CLAIM_PATH = "https://api.openai.com/auth";
const REFRESH_EARLY_MILLIS = 300_000;
const MAX_LABEL_CODE_POINTS = 80;

const NonEmptyString = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
);
const AccountLabel = NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(MAX_LABEL_CODE_POINTS)),
);
const NonNegativeInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);

const ManagedAccountSchema = Schema.Struct({
  id: NonEmptyString,
  label: AccountLabel,
  providerAccountId: NonEmptyString,
  accessToken: NonEmptyString,
  refreshToken: NonEmptyString,
  expiresAt: NonNegativeInteger,
  createdAt: NonNegativeInteger,
  updatedAt: NonNegativeInteger,
  needsReauth: Schema.Boolean,
});

const AccountVaultFileSchema = Schema.Struct({
  version: Schema.Literal(1),
  accounts: Schema.Array(ManagedAccountSchema),
});

const CodexAccessTokenClaims = Schema.Struct({
  [CLAIM_PATH]: Schema.Struct({
    chatgpt_account_id: NonEmptyString,
  }),
});

export type AccountVaultFile = Schema.Schema.Type<
  typeof AccountVaultFileSchema
>;
type ManagedAccount = AccountVaultFile["accounts"][number];
type RefreshOutcome =
  | {
      readonly _tag: "Success";
      readonly credential: FreshCredential;
    }
  | {
      readonly _tag: "Failure";
      readonly error: AccountVaultError;
    };

export interface ManagedAccountSummary {
  readonly id: string;
  readonly label: string;
  readonly expiresAt: number;
  readonly needsReauth: boolean;
}

export interface FreshCredential {
  readonly providerAccountId: string;
  readonly accessToken: string;
  readonly expiresAt: number;
}

const AccountVaultErrorCode = Schema.Literals([
  "account_not_found",
  "needs_reauthentication",
  "invalid_credential",
  "refresh_transient",
  "storage_unavailable",
]);

export class AccountVaultError extends Schema.TaggedErrorClass<AccountVaultError>()(
  "AccountVaultError",
  { code: AccountVaultErrorCode },
) {}

export interface AccountVault {
  readonly list: Effect.Effect<
    ReadonlyArray<ManagedAccountSummary>,
    AccountVaultError
  >;
  readonly addFromOAuth: (
    label: string,
    credentials: OAuthCredentials,
  ) => Effect.Effect<string, AccountVaultError>;
  readonly getFreshCredential: (
    id: string,
  ) => Effect.Effect<FreshCredential, AccountVaultError>;
  readonly remove: (
    id: string,
  ) => Effect.Effect<boolean, AccountVaultError>;
  readonly markNeedsReauth: (
    id: string,
    rejectedAccessToken?: string,
  ) => Effect.Effect<boolean, AccountVaultError>;
}

export function makeAccountVaultStore(
  path: string,
  options: {
    readonly lockTimeoutMillis?: number;
    readonly maximumBytes?: number;
  } = {},
) {
  return makeAtomicJsonStore({
    path,
    schema: AccountVaultFileSchema,
    createDefault: (): AccountVaultFile => ({ version: 1, accounts: [] }),
    ...options,
  });
}

export const extractCodexAccountId = Effect.fn(
  "agentos.aiGateway.extractCodexAccountId",
)(function*(accessToken: string) {
  const payload = accessToken.split(".")[1];
  if (payload === undefined || accessToken.split(".").length !== 3) {
    return yield* accountError("invalid_credential");
  }
  const source = yield* Effect.try({
    try: () => Buffer.from(payload, "base64url").toString("utf8"),
    catch: () => accountError("invalid_credential"),
  });
  const claims = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(CodexAccessTokenClaims),
  )(source).pipe(
    Effect.mapError(() => accountError("invalid_credential")),
  );
  return claims[CLAIM_PATH].chatgpt_account_id;
});

export const makeAccountVault = Effect.fn(
  "agentos.aiGateway.makeAccountVault",
)(function*(options: {
  readonly store: AtomicJsonStore<AccountVaultFile>;
  readonly oauth: CodexOAuthRefreshClient;
  readonly now?: Effect.Effect<number>;
}) {
  const crypto = yield* Crypto.Crypto;
  const now = options.now ?? Clock.currentTimeMillis;

  const deriveManagedAccountId = Effect.fn(
    "agentos.aiGateway.deriveManagedAccountId",
  )(function*(providerAccountId: string) {
    const digest = yield* crypto.digest(
      "SHA-256",
      new TextEncoder().encode(providerAccountId),
    ).pipe(Effect.mapError(() => accountError("storage_unavailable")));
    return `codex-${Encoding.encodeHex(digest).slice(0, 12)}`;
  });

  const read = options.store.read.pipe(
    Effect.mapError(storageError),
  );

  const find = Effect.fn("agentos.aiGateway.findManagedAccount")(
    function*(id: string, file?: AccountVaultFile) {
      const state = file ?? (yield* read);
      const account = state.accounts.find((value) => value.id === id);
      return account ?? (yield* accountError("account_not_found"));
    },
  );

  const refresh = Effect.fn("agentos.aiGateway.refreshManagedAccount")(
    function*(id: string) {
      const outcome = yield* options.store.modify<
        RefreshOutcome,
        AccountVaultError,
        never
      >((file) =>
        Effect.gen(function*() {
          const account = yield* find(id, file);
          if (account.needsReauth) {
            return refreshFailure(
              accountError("needs_reauthentication"),
              file,
            );
          }
          const observedAt = yield* now;
          if (!needsRefresh(account.expiresAt, observedAt)) {
            return refreshSuccess(fresh(account), file);
          }

          const refreshed = yield* Effect.result(
            options.oauth.refresh(account.refreshToken),
          );
          if (refreshed._tag === "Failure") {
            const failure = refreshed.failure.code === "invalid_grant"
              ? accountError("needs_reauthentication")
              : accountError("refresh_transient");
            return refreshFailure(
              failure,
              refreshed.failure.code === "invalid_grant"
                ? invalidateAccount(file, account, observedAt)
                : file,
            );
          }

          const credentials = refreshed.success;
          const providerAccountId = yield* extractCodexAccountId(
            credentials.access,
          ).pipe(Effect.option);
          if (
            providerAccountId._tag === "None" ||
            providerAccountId.value !== account.providerAccountId ||
            !validRefreshCredential(credentials)
          ) {
            return refreshFailure(
              accountError("needs_reauthentication"),
              invalidateAccount(file, account, observedAt),
            );
          }

          const next = {
            ...file,
            accounts: file.accounts.map((value) =>
              value.id === id && sameCredentialSource(value, account)
                ? {
                    ...value,
                    accessToken: credentials.access,
                    refreshToken: credentials.refresh,
                    expiresAt: credentials.expires,
                    updatedAt: observedAt,
                    needsReauth: false,
                  }
                : value
            ),
          };
          const saved = next.accounts.find((value) => value.id === id);
          return saved === undefined
            ? refreshFailure(accountError("account_not_found"), next)
            : refreshSuccess(fresh(saved), next);
        })
      ).pipe(Effect.mapError((error) =>
        error._tag === "AccountVaultError" ? error : storageError(error)
      ));
      return outcome._tag === "Failure"
        ? yield* outcome.error
        : outcome.credential;
    },
  );

  return {
    list: read.pipe(
      Effect.map((file) =>
        file.accounts.map((account) => ({
          id: account.id,
          label: account.label,
          expiresAt: account.expiresAt,
          needsReauth: account.needsReauth,
        }))
      ),
    ),

    addFromOAuth: (label, credentials) =>
      Effect.gen(function*() {
        const providerAccountId = yield* extractCodexAccountId(
          credentials.access,
        );
        if (!validRefreshCredential(credentials)) {
          return yield* accountError("invalid_credential");
        }
        const id = yield* deriveManagedAccountId(providerAccountId);
        const observedAt = yield* now;
        const normalizedLabel = normalizeAccountLabel(
          label,
          `Account ${id.slice(-6)}`,
        );
        yield* options.store.update((file) => {
          const existing = file.accounts.find(
            (account) => account.providerAccountId === providerAccountId,
          );
          const next = {
            id,
            label: normalizedLabel,
            providerAccountId,
            accessToken: credentials.access,
            refreshToken: credentials.refresh,
            expiresAt: credentials.expires,
            createdAt: existing?.createdAt ?? observedAt,
            updatedAt: observedAt,
            needsReauth: false,
          };
          return Effect.succeed({
            ...file,
            accounts: existing === undefined
              ? [...file.accounts, next]
              : file.accounts.map((account) =>
                  account.providerAccountId === providerAccountId
                    ? next
                    : account
                ),
          });
        }).pipe(Effect.mapError(storageError));
        return id;
      }),

    getFreshCredential: (id) =>
      Effect.gen(function*() {
        const account = yield* find(id);
        if (account.needsReauth) {
          return yield* accountError("needs_reauthentication");
        }
        const observedAt = yield* now;
        return needsRefresh(account.expiresAt, observedAt)
          ? yield* refresh(id)
          : fresh(account);
      }),

    remove: (id) =>
      options.store.modify((file) => {
        const accounts = file.accounts.filter((account) => account.id !== id);
        return Effect.succeed([
          accounts.length !== file.accounts.length,
          { ...file, accounts },
        ]);
      }).pipe(Effect.mapError(storageError)),

    markNeedsReauth: (id, rejectedAccessToken) =>
      options.store.modify((file) =>
        Effect.gen(function*() {
          const observedAt = yield* now;
          let marked = false;
          const accounts = file.accounts.map((account) => {
            if (
              account.id !== id ||
              (rejectedAccessToken !== undefined &&
                account.accessToken !== rejectedAccessToken)
            ) {
              return account;
            }
            marked = true;
            return {
              ...account,
              needsReauth: true,
              updatedAt: observedAt,
            };
          });
          return [marked, { ...file, accounts }];
        })
      ).pipe(Effect.mapError(storageError)),
  } satisfies AccountVault;
});

function fresh(account: ManagedAccount): FreshCredential {
  return {
    providerAccountId: account.providerAccountId,
    accessToken: account.accessToken,
    expiresAt: account.expiresAt,
  };
}

function refreshSuccess(
  credential: FreshCredential,
  state: AccountVaultFile,
): readonly [RefreshOutcome, AccountVaultFile] {
  return [{ _tag: "Success", credential }, state];
}

function refreshFailure(
  error: AccountVaultError,
  state: AccountVaultFile,
): readonly [RefreshOutcome, AccountVaultFile] {
  return [{ _tag: "Failure", error }, state];
}

function normalizeAccountLabel(label: string, fallback: string): string {
  const printable = Array.from(label, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 0x20 && codePoint !== 0x7f ? character : " ";
  }).join("").replaceAll(/\s+/g, " ").trim();
  return Array.from(printable || fallback)
    .slice(0, MAX_LABEL_CODE_POINTS)
    .join("");
}

function needsRefresh(expiresAt: number, now: number): boolean {
  return expiresAt <= now + REFRESH_EARLY_MILLIS;
}

function validRefreshCredential(credentials: OAuthCredentials): boolean {
  return (
    credentials.access.length > 0 &&
    credentials.refresh.length > 0 &&
    Number.isSafeInteger(credentials.expires) &&
    credentials.expires >= 0
  );
}

function invalidateAccount(
  file: AccountVaultFile,
  source: ManagedAccount,
  observedAt: number,
): AccountVaultFile {
  return {
    ...file,
    accounts: file.accounts.map((account) =>
      account.id === source.id && sameCredentialSource(account, source)
        ? { ...account, needsReauth: true, updatedAt: observedAt }
        : account
    ),
  };
}

function sameCredentialSource(
  left: ManagedAccount,
  right: ManagedAccount,
): boolean {
  return (
    left.providerAccountId === right.providerAccountId &&
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken
  );
}

function accountError(code: AccountVaultError["code"]) {
  return AccountVaultError.make({ code });
}

function storageError(_error: AtomicJsonStoreError) {
  return accountError("storage_unavailable");
}

