// Sends email through Resend (https://resend.com) when RESEND_API_KEY is set.
// Otherwise it logs the message, which is enough for local development.

function createMailer() {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || 'MFL Fantasy <onboarding@resend.dev>';
  return {
    async send({ to, subject, text }) {
      if (!key) {
        console.log(`\n[email to ${to}] ${subject}\n${text}\n`);
        return;
      }
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to, subject, text }),
      });
      if (!res.ok) console.error(`Email to ${to} failed: ${res.status} ${await res.text()}`);
    },
  };
}

module.exports = { createMailer };
