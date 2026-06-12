export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { password } = req.body
  // Defina aqui a senha do admin (ou use variável de ambiente)
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' })
  }

  const token = process.env.ADMIN_SECRET_TOKEN || 'meuTokenSuperSeguro'
  res.status(200).json({ token })
}
