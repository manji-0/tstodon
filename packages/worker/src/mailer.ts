import { err, ok, type Result } from "neverthrow";

/**
 * Outgoing mail. `EMAIL_TRANSPORT` picks how it leaves:
 *
 * - `send_email` (default): the `EMAIL` send_email binding (Cloudflare Email
 *   Service), from `EMAIL_FROM`.
 * - `capture`: the message is written to `APP_CACHE` under
 *   `mailbox:<recipient>` for an hour instead of being sent. Tests and the
 *   local e2e instances read sign-up links from there; never use it for a
 *   real instance.
 */

export type OutgoingEmail = Readonly<{
  to: string;
  subject: string;
  text: string;
  html: string;
}>;

export type MailError = Readonly<{ kind: "MailError"; message: string }>;

export const mailboxKey = (to: string): string => `mailbox:${to.toLowerCase()}`;

/** `Name <address>` (or a bare address) as the binding's sender. */
export const senderAddress = (raw: string): string | EmailAddress => {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(raw);
  return match?.[2] ? { name: match[1] ?? "", email: match[2] } : raw.trim();
};

export const sendEmail = async (
  env: Env,
  message: OutgoingEmail,
): Promise<Result<void, MailError>> => {
  try {
    if (String(env.EMAIL_TRANSPORT) === "capture") {
      await env.APP_CACHE.put(mailboxKey(message.to), JSON.stringify(message), {
        expirationTtl: 3600,
      });
      return ok(undefined);
    }
    await env.EMAIL.send({
      from: senderAddress(env.EMAIL_FROM),
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return ok(undefined);
  } catch (cause) {
    return err({
      kind: "MailError",
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
};
