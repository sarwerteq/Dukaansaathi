const nodemailer = require("nodemailer");

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    throw new Error("Email is not configured on the server. Set GMAIL_USER and GMAIL_APP_PASSWORD.");
  }
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  return transporter;
}

async function sendOtpEmail(to, code) {
  const t = getTransporter();
  await t.sendMail({
    from: `"DukaanSaathi" <${process.env.GMAIL_USER}>`,
    to,
    subject: `Your DukaanSaathi login code: ${code}`,
    text: `Your one-time login code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
  });
}

module.exports = { sendOtpEmail };
