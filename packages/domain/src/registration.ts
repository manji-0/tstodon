import { Sensitive, type SensitiveValue } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { AccessEmail } from "./access-email";
import { AccountId } from "./account-id";
import { IsoInstant } from "./iso-instant";
import { QuoteApprovalPolicy } from "./quote-approval-policy";
import { Username } from "./username";
import { Visibility } from "./visibility";

const FieldIssueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("Blank") }),
  z.object({ kind: z.literal("InvalidFormat") }),
  z.object({ kind: z.literal("MustBeAccepted") }),
  z.object({ kind: z.literal("Taken") }),
]);

export type RegistrationFieldIssue = z.infer<typeof FieldIssueSchema>;

const AbsentIssueSchema = z.object({ kind: z.literal("None") });
const PresentIssueSchema = z.object({
  kind: z.literal("Issue"),
  issue: FieldIssueSchema,
});

export const RegistrationFieldStateSchema = z.discriminatedUnion("kind", [
  AbsentIssueSchema,
  PresentIssueSchema,
]);

export type RegistrationFieldState = z.infer<typeof RegistrationFieldStateSchema>;

export const RegistrationValidationErrorsSchema = z.object({
  kind: z.literal("RegistrationValidationErrors"),
  username: RegistrationFieldStateSchema,
  email: RegistrationFieldStateSchema,
  password: RegistrationFieldStateSchema,
  agreement: RegistrationFieldStateSchema,
});

export type RegistrationValidationErrors = z.infer<typeof RegistrationValidationErrorsSchema>;

const noneIssue = { kind: "None" } as const satisfies RegistrationFieldState;

const ComposingSchema = z.object({
  kind: z.literal("Composing"),
  username: z.string(),
  email: z.string(),
  passwordPresent: z.boolean(),
  agreement: z.boolean(),
});

const IntentSchema = z.object({
  kind: z.literal("IntentValidated"),
  username: Username.schema,
  email: AccessEmail.schema,
});

const RegisteringSchema = z.object({
  kind: z.literal("Registering"),
  id: AccountId.schema,
  username: Username.schema,
  email: AccessEmail.schema,
  displayName: z.string().min(1),
  publicKeyPem: z.string().min(1),
  privateKeyJwk: z.string().min(1),
});

export const RegistrationSchema = z.discriminatedUnion("kind", [
  ComposingSchema,
  IntentSchema,
  RegisteringSchema,
]);

export type Registration = z.infer<typeof RegistrationSchema>;
export type ComposingRegistration = z.infer<typeof ComposingSchema>;
export type RegistrationIntent = z.infer<typeof IntentSchema>;
export type RegisteringAccount = z.infer<typeof RegisteringSchema>;

const issue = (kind: RegistrationFieldIssue["kind"]): RegistrationFieldState => ({
  kind: "Issue",
  issue: { kind },
});

export const Registration = {
  schema: RegistrationSchema,
  composing: (input: {
    username: string;
    email: string;
    passwordPresent: boolean;
    agreement: boolean;
  }): ComposingRegistration => ({
    kind: "Composing",
    ...input,
  }),
  validate: (
    composing: ComposingRegistration,
  ): Result<RegistrationIntent, RegistrationValidationErrors> => {
    const username = Username.parse(composing.username);
    const email = AccessEmail.parse(composing.email);
    const errors: RegistrationValidationErrors = {
      kind: "RegistrationValidationErrors",
      username: username.isErr()
        ? issue(username.error.kind === "Blank" ? "Blank" : "InvalidFormat")
        : noneIssue,
      email: email.isErr()
        ? issue(email.error.kind === "Blank" ? "Blank" : "InvalidFormat")
        : noneIssue,
      password: composing.passwordPresent ? noneIssue : issue("Blank"),
      agreement: composing.agreement ? noneIssue : issue("MustBeAccepted"),
    };
    if (
      errors.username.kind !== "None" ||
      errors.email.kind !== "None" ||
      errors.password.kind !== "None" ||
      errors.agreement.kind !== "None"
    ) {
      return err(errors);
    }
    if (username.isErr() || email.isErr()) {
      return err(errors);
    }
    return ok({
      kind: "IntentValidated",
      username: username.value,
      email: email.value,
    });
  },
  register: (
    intent: RegistrationIntent,
    id: AccountId,
    keys: Readonly<{ publicKeyPem: string; privateKeyJwk: string }>,
  ): RegisteringAccount => ({
    kind: "Registering",
    id,
    username: intent.username,
    email: intent.email,
    displayName: intent.username,
    publicKeyPem: keys.publicKeyPem,
    privateKeyJwk: keys.privateKeyJwk,
  }),
} as const;

export const LocalAccountSchema = z.object({
  kind: z.literal("LocalAccount"),
  id: AccountId.schema,
  username: Username.schema,
  accessEmail: AccessEmail.schema.transform((email): SensitiveValue<typeof email> =>
    Sensitive.of(email),
  ),
  displayName: z.string(),
  locked: z.boolean(),
  defaultPostVisibility: Visibility.schema,
  defaultQuotePolicy: QuoteApprovalPolicy.schema,
  publicKeyPem: z.string().min(1),
  privateKeyJwk: z
    .string()
    .min(1)
    .transform((jwk): SensitiveValue<string> => Sensitive.of(jwk)),
  createdAt: IsoInstant.schema,
});

export type LocalAccount = z.infer<typeof LocalAccountSchema>;

export const LocalAccount = {
  schema: LocalAccountSchema,
  provision: (
    registering: RegisteringAccount,
    createdAt: z.infer<typeof IsoInstant.schema>,
  ): LocalAccount => ({
    kind: "LocalAccount",
    id: registering.id,
    username: registering.username,
    accessEmail: Sensitive.of(registering.email),
    displayName: registering.displayName,
    locked: false,
    defaultPostVisibility: Visibility.Public,
    defaultQuotePolicy: QuoteApprovalPolicy.Public,
    publicKeyPem: registering.publicKeyPem,
    privateKeyJwk: Sensitive.of(registering.privateKeyJwk),
    createdAt,
  }),
} as const;
