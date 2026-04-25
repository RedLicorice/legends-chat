import nodemailer from "nodemailer";

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!process.env.SMTP_HOST) {
    console.log(`[email] To: ${to} | Subject: ${subject}`);
    console.log(`[email] Body: ${html.replace(/<[^>]+>/g, "")}`);
    return;
  }
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  await transport.sendMail({
    from: process.env.SMTP_FROM ?? `noreply@${process.env.SMTP_HOST}`,
    to,
    subject,
    html,
  });
}
