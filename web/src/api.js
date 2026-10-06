const BASE = '/api'

/**
 * Fetch JSON from the API. Kept deliberately small: filter state and the typed endpoint
 * wrappers arrive with the query layer, and everything the UI shows must go through one
 * path so the file, directory and dashboard views can never disagree.
 */
export async function getJson(path, params = {}) {
  const url = new URL(`${BASE}${path}`, window.location.origin)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  }

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
  return response.json()
}
