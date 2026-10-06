const BREVO_API_KEY = process.env.BREVO_API_KEY;
const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL;

async function sendOtpEmail(to, code) {
  if (!BREVO_API_KEY || !SENDER_EMAIL) {
    throw new Error("Email is not configured on the server. Set BREVO_API_KEY and BREVO_SENDER_EMAIL.");
  }
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": BREVO_API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      sender: { email: SENDER_EMAIL, name: "DukaanSaathi" },
      to: [{ email: to }],
      subject: `Your DukaanSaathi login code: ${code}`,
      textContent: `Your one-time login code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Brevo API error (${res.status}): ${body.slice(0, 200)}`);
  }
}

module.exports = { sendOtpEmail };
