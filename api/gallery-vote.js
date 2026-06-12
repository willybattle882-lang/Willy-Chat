import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()
  const { winnerId, loserId } = req.body

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  )

  try {
    // Incrementa votes do vencedor e losses do perdedor
    await supabase.rpc('increment_vote', { photo_id: winnerId })
    await supabase.rpc('increment_loss', { photo_id: loserId })
    return res.status(200).json({ success: true })
  } catch (err) {
    // Fallback: update direto se a RPC não existir
    try {
      await supabase.from('gallery_photos').update({ votes: supabase.raw('votes + 1') }).eq('id', winnerId)
      await supabase.from('gallery_photos').update({ losses: supabase.raw('losses + 1') }).eq('id', loserId)
      return res.status(200).json({ success: true })
    } catch (err2) {
      console.error(err2)
      return res.status(500).json({ error: err2.message })
    }
  }
}
