import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { winnerId, loserId } = req.body
  if (!winnerId || !loserId) return res.status(400).json({ error: 'winnerId and loserId required' })
  if (winnerId === loserId) return res.status(400).json({ error: 'winnerId and loserId must be different' })

  // Busca valores atuais
  const { data: winner } = await db.from('gallery_photos').select('votes').eq('id', winnerId).single()
  const { data: loser } = await db.from('gallery_photos').select('losses').eq('id', loserId).single()

  if (!winner || !loser) return res.status(404).json({ error: 'Photo not found' })

  // Atualiza vencedor e perdedor
  await db.from('gallery_photos').update({ votes: (winner.votes || 0) + 1 }).eq('id', winnerId)
  await db.from('gallery_photos').update({ losses: (loser.losses || 0) + 1 }).eq('id', loserId)

  return res.status(200).json({ success: true })
}
