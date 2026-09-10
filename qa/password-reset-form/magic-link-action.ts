"use server";

type Actions = typeof import("../../src/shared/register/actions");

export async function sendEmailMagicLink(
  ...args: Parameters<Actions["sendEmailMagicLink"]>
): Promise<Awaited<ReturnType<Actions["sendEmailMagicLink"]>>> {
  void args;
  throw new Error("QA action escaped browser interception");
}
