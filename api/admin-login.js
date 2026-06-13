export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { password } = req.body
  if (!password) return res.status(400).json({ error: 'Password required' })

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' })
  }

  // Gera token de sessão simples (válido por 2 horas)
  const token = Buffer.from(`admin:${Date.now()}`).toString('base64')
  return res.status(200).json({ token })
}
