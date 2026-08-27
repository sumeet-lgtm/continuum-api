import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { config } from '../config.js';

const sesClient = new SESv2Client({ region: config.AWS_REGION ?? 'us-east-1' });

function interpolate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(data[key] ?? ''));
}

export async function runAutomationWorker(): Promise<void> {
  logger.info('Automation worker: checking enrollments');

  const now = new Date();

  const enrollments = await prisma.automationEnrollment.findMany({
    where: {
      status: 'active',
      nextSendAt: { lte: now },
    },
    include: {
      automation: {
        include: {
          steps: { orderBy: { stepOrder: 'asc' } },
        },
      },
    },
    take: 200,
  });

  logger.info({ count: enrollments.length }, 'Automation enrollments due');

  for (const enrollment of enrollments) {
    const step = enrollment.automation.steps[enrollment.currentStep];

    if (!step) {
      // All steps done — mark completed
      await prisma.automationEnrollment.update({
        where: { id: enrollment.id },
        data: { status: 'completed', completedAt: now },
      });
      continue;
    }

    // Check suppression
    const suppressed = await prisma.suppression.findUnique({ where: { email: enrollment.email } });
    if (suppressed) {
      await prisma.automationEnrollment.update({
        where: { id: enrollment.id },
        data: { status: 'unsubscribed', completedAt: now },
      });
      continue;
    }

    const variables = { email: enrollment.email, ...(enrollment.data as Record<string, unknown> ?? {}) };
    const subject = interpolate(step.subject, variables);
    const htmlBody = interpolate(step.htmlBody, variables);
    const textBody = step.textBody ? interpolate(step.textBody, variables) : undefined;

    const fromEmail = step.fromEmail ?? process.env['DEFAULT_FROM_EMAIL'] ?? 'noreply@continuumapi.com';
    const fromName = step.fromName ?? 'Continuum';

    try {
      await sesClient.send(new SendEmailCommand({
        FromEmailAddress: `${fromName} <${fromEmail}>`,
        Destination: { ToAddresses: [enrollment.email] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: htmlBody, Charset: 'UTF-8' },
              ...(textBody ? { Text: { Data: textBody, Charset: 'UTF-8' } } : {}),
            },
          },
        },
      }));

      logger.info({ enrollmentId: enrollment.id, email: enrollment.email, stepOrder: step.stepOrder }, 'Automation step sent');

      // Advance to next step
      const nextStep = enrollment.automation.steps[enrollment.currentStep + 1];
      const nextSendAt = nextStep
        ? new Date(Date.now() + nextStep.delayHours * 3600 * 1000)
        : null;

      if (nextSendAt) {
        await prisma.automationEnrollment.update({
          where: { id: enrollment.id },
          data: { currentStep: enrollment.currentStep + 1, nextSendAt },
        });
      } else {
        await prisma.automationEnrollment.update({
          where: { id: enrollment.id },
          data: { status: 'completed', completedAt: new Date() },
        });
      }
    } catch (err) {
      logger.error({ err, enrollmentId: enrollment.id }, 'Automation step send failed');
      // Leave status as active; nextSendAt will be re-tried on next worker run
      // Bump nextSendAt by 15 minutes to avoid tight retry loop
      await prisma.automationEnrollment.update({
        where: { id: enrollment.id },
        data: { nextSendAt: new Date(Date.now() + 15 * 60 * 1000) },
      });
    }
  }

  logger.info('Automation worker: cycle complete');
}
