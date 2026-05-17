const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL;
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME ?? "SapAi";

async function sendEmail(
  toEmail: string,
  subject: string,
  htmlContent: string,
  textContent: string,
): Promise<void> {
  const apiKey = BREVO_API_KEY;
  const senderEmail = BREVO_SENDER_EMAIL;
  if (!apiKey || !senderEmail) {
    throw new Error("Missing Brevo environment variables.");
  }

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify({
      sender: { email: senderEmail, name: BREVO_SENDER_NAME },
      to: [{ email: toEmail }],
      subject,
      htmlContent,
      textContent,
    }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Brevo send failed: ${responseText}`);
  }
}

export async function sendOtpEmail(email: string, otp: string): Promise<void> {
  const subject = "Your SapAi verification code";
  const htmlContent = `
    <div style="margin:0;padding:0;background:#f4f4f5;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0;">
        <tr>
          <td align="center">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden;">
              <tr>
                <td style="padding:24px 24px 8px;font-family:Arial,Helvetica,sans-serif;color:#111827;">
                  <h1 style="margin:0;font-size:20px;line-height:1.3;">Verify your email</h1>
                </td>
              </tr>
              <tr>
                <td style="padding:8px 24px 0;font-family:Arial,Helvetica,sans-serif;color:#374151;font-size:14px;line-height:1.6;">
                  Use this one-time password (OTP) to complete your SapAi registration.
                </td>
              </tr>
              <tr>
                <td style="padding:16px 24px;">
                  <div style="display:inline-block;background:#18181b;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:28px;letter-spacing:6px;font-weight:700;padding:12px 18px;border-radius:10px;">
                    ${otp}
                  </div>
                </td>
              </tr>
              <tr>
                <td style="padding:0 24px 20px;font-family:Arial,Helvetica,sans-serif;color:#6b7280;font-size:13px;line-height:1.6;">
                  This code expires soon. If you did not request this email, you can safely ignore it.
                </td>
              </tr>
              <tr>
                <td style="padding:16px 24px;background:#fafafa;border-top:1px solid #e5e7eb;font-family:Arial,Helvetica,sans-serif;color:#9ca3af;font-size:12px;">
                  SapAi Security Notification
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </div>
  `;
  const textContent = `Your SapAi verification code is ${otp}. This code expires soon.`;
  await sendEmail(email, subject, htmlContent, textContent);
}

export async function sendPasswordResetEmail(email: string, otp: string): Promise<void> {
  const subject = "Reset your SapAi password";
  const htmlContent = `
    <div style="margin:0;padding:0;background:#f4f4f5;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0;">
        <tr>
          <td align="center">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden;">
              <tr>
                <td style="padding:24px 24px 8px;font-family:Arial,Helvetica,sans-serif;color:#111827;">
                  <h1 style="margin:0;font-size:20px;line-height:1.3;">Reset your password</h1>
                </td>
              </tr>
              <tr>
                <td style="padding:8px 24px 0;font-family:Arial,Helvetica,sans-serif;color:#374151;font-size:14px;line-height:1.6;">
                  Use this one-time password (OTP) to reset your SapAi password.
                </td>
              </tr>
              <tr>
                <td style="padding:16px 24px;">
                  <div style="display:inline-block;background:#18181b;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:28px;letter-spacing:6px;font-weight:700;padding:12px 18px;border-radius:10px;">
                    ${otp}
                  </div>
                </td>
              </tr>
              <tr>
                <td style="padding:0 24px 20px;font-family:Arial,Helvetica,sans-serif;color:#6b7280;font-size:13px;line-height:1.6;">
                  If you did not request a password reset, you can safely ignore this email.
                </td>
              </tr>
              <tr>
                <td style="padding:16px 24px;background:#fafafa;border-top:1px solid #e5e7eb;font-family:Arial,Helvetica,sans-serif;color:#9ca3af;font-size:12px;">
                  SapAi Security Notification
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </div>
  `;
  const textContent = `Your SapAi password reset code is ${otp}. If you did not request a reset, ignore this email.`;
  await sendEmail(email, subject, htmlContent, textContent);
}

