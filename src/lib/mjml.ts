import { Errors } from '../plugins/errorHandler.js';

// Compile MJML markup to HTML. Throws a validation error if MJML reports errors.
export async function compileMjml(mjmlBody: string): Promise<string> {
  const mjmlMod = await import('mjml') as { default?: unknown } & Record<string, unknown>;
  // mjml exports a default function in CJS interop
  const compileFn = (mjmlMod.default ?? mjmlMod) as (
    input: string,
    opts?: object,
  ) => { html: string; errors: Array<{ formattedMessage: string }> };
  const result = (compileFn as unknown as (i: string, o?: object) => { html: string; errors: Array<{ formattedMessage: string }> })(mjmlBody, { validationLevel: 'soft' });
  if (result.errors.length > 0) {
    const messages = result.errors.map((e: { formattedMessage: string }) => e.formattedMessage).join('; ');
    throw Errors.validationFailed([{ field: 'mjml_body', message: `MJML compilation failed: ${messages}` }]);
  }
  return result.html;
}
