import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()
  const { photoId } = req.body

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )

  try {
    const { data, error } = await supabase
      .from('gallery_photos')
      .update({ championships: supabase.raw('championships + 1') })
      .eq('id', photoId)
      .select()
    if (error) throw error
    return res.status(200).json({ championships: data[0]?.championships || 0 })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
