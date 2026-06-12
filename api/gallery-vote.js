import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { winnerId, loserId } = req.body
  if (!winnerId || !loserId) return res.status(400).json({ error: 'winnerId and loserId required' })
  if (winnerId === loserId) return res.status(400).json({ error: 'winnerId and loserId must be different' })

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  )

  // Busca valores atuais dos dois em paralelo
  const [{ data: winner }, { data: loser }] = await Promise.all([
    db.from('gallery_photos').select('votes').eq('id', winnerId).single(),
    db.from('gallery_photos').select('losses').eq('id', loserId).single()
  ])

  if (!winner || !loser) return res.status(404).json({ error: 'Photo not found' })

  // Atualiza em paralelo
  await Promise.all([
    db.from('gallery_photos').update({ votes: (winner.votes || 0) + 1 }).eq('id', winnerId),
    db.from('gallery_photos').update({ losses: (loser.losses || 0) + 1 }).eq('id', loserId)
  ])

  return res.status(200).json({ success: true })
}
