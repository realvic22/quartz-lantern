import { connect, disconnect, isConnected, request } from '@stacks/connect'
import { Cl, cvToHex, cvToJSON, hexToCV, type ClarityValue } from '@stacks/transactions'
import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'

const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || 'SP2V3QE7H5D09N108CJ4QPS281Z3XAZVD87R8FJ27'
const CONTRACT_NAME = import.meta.env.VITE_CONTRACT_NAME || 'community-guestbook'
const STACKS_API_BASE = import.meta.env.VITE_STACKS_API_BASE || 'https://api.hiro.so'
const NETWORK = (import.meta.env.VITE_STACKS_NETWORK || 'mainnet') as 'mainnet' | 'testnet'

type Community = {
  id: number
  owner: string
  name: string
  description: string
  rateLimitBlocks: number
  active: boolean
  createdHeight: number
  entryCount: number
}

type Entry = {
  id: number
  author: string
  message: string
  createdHeight: number
}

const ERROR_HINTS: Record<string, string> = {
  u100: 'Community not found.',
  u101: 'Community is inactive.',
  u102: 'Rate limit active. Try again later.',
  u103: 'Only the community owner can perform this action.',
  u104: 'Invalid rate limit value.',
}

function unwrapValue(value: unknown): unknown {
  if (value && typeof value === 'object' && 'value' in value) {
    return unwrapValue((value as { value: unknown }).value)
  }
  return value
}

function asNumber(value: unknown): number {
  const inner = unwrapValue(value)
  if (typeof inner === 'number') return inner
  if (typeof inner === 'string' && /^\d+$/.test(inner)) return Number(inner)
  return 0
}

function asBool(value: unknown): boolean {
  const inner = unwrapValue(value)
  return Boolean(inner)
}

function asText(value: unknown): string {
  const inner = unwrapValue(value)
  return typeof inner === 'string' ? inner : ''
}

function asRecord(value: unknown): Record<string, unknown> {
  const inner = unwrapValue(value)
  return inner && typeof inner === 'object' ? (inner as Record<string, unknown>) : {}
}

function extractResponseValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const response = value as { success?: boolean; value?: unknown }
  if (response.success === false) throw new Error('Read-only call returned err response')
  if ('value' in response) return response.value
  return value
}

function humanizeContractError(error: unknown): string {
  const text = error instanceof Error ? error.message : 'Transaction failed'
  const matched = Object.entries(ERROR_HINTS).find(([code]) => text.includes(code))
  return matched ? matched[1] : text
}

function App() {
  const [address, setAddress] = useState('')
  const [communities, setCommunities] = useState<Community[]>([])
  const [selectedCommunityId, setSelectedCommunityId] = useState<number | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [canSignNow, setCanSignNow] = useState(false)
  const [lastEntryHeight, setLastEntryHeight] = useState(0)

  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newRateLimit, setNewRateLimit] = useState('10')

  const [newMessage, setNewMessage] = useState('')
  const [newOwnerRateLimit, setNewOwnerRateLimit] = useState('10')

  const [history, setHistory] = useState<string[]>([])
  const [status, setStatus] = useState('Ready')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const contractId = useMemo(() => `${CONTRACT_ADDRESS}.${CONTRACT_NAME}` as `${string}.${string}`, [])
  const walletConnected = Boolean(address)

  const selectedCommunity = communities.find((community) => community.id === selectedCommunityId) ?? null
  const isOwner = Boolean(selectedCommunity && selectedCommunity.owner === address)

  const callReadOnly = useCallback(
    async (functionName: string, args: string[] = []) => {
      const sender = address || CONTRACT_ADDRESS
      const response = await fetch(
        `${STACKS_API_BASE}/v2/contracts/call-read/${CONTRACT_ADDRESS}/${CONTRACT_NAME}/${functionName}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sender, arguments: args }),
        },
      )

      const data = await response.json()
      if (!data.okay) {
        throw new Error(data.cause || `Read failed: ${functionName}`)
      }
      return cvToJSON(hexToCV(data.result))
    },
    [address],
  )

  const callTx = useCallback(
    async (functionName: string, functionArgs: ClarityValue[]) => {
      return request('stx_callContract', {
        contract: contractId,
        functionName,
        functionArgs,
        network: NETWORK,
        postConditionMode: 'deny',
        sponsored: false,
      })
    },
    [contractId],
  )

  const addHistory = (item: string) => {
    setHistory((current) => [item, ...current].slice(0, 12))
  }

  const loadCommunities = useCallback(async () => {
    const countResult = await callReadOnly('get-community-count')
    const count = asNumber(extractResponseValue(countResult))
    if (count < 1) {
      setCommunities([])
      setSelectedCommunityId(null)
      return
    }

    const reads = await Promise.all(
      Array.from({ length: count }, (_, idx) => callReadOnly('get-community', [cvToHex(Cl.uint(idx + 1))])),
    )

    const next = reads
      .map((result, idx) => {
        const payload = extractResponseValue(result)
        if (!payload) return null
        const tuple = asRecord(payload)
        if (!tuple.owner) return null
        return {
          id: idx + 1,
          owner: asText(tuple.owner),
          name: asText(tuple.name),
          description: asText(tuple.description),
          rateLimitBlocks: asNumber(tuple['rate-limit-blocks']),
          active: asBool(tuple.active),
          createdHeight: asNumber(tuple['created-height']),
          entryCount: asNumber(tuple['entry-count']),
        } as Community
      })
      .filter((item): item is Community => Boolean(item))

    setCommunities(next)
    setSelectedCommunityId((current) => {
      if (current && next.some((community) => community.id === current)) return current
      return next[0]?.id ?? null
    })
  }, [callReadOnly])

  const loadSelectedCommunityData = useCallback(async () => {
    if (!selectedCommunityId || !address) {
      setEntries([])
      setCanSignNow(false)
      setLastEntryHeight(0)
      return
    }

    const [selectedRead, canSignRead, lastHeightRead] = await Promise.all([
      callReadOnly('get-community', [cvToHex(Cl.uint(selectedCommunityId))]),
      callReadOnly('can-sign-now', [cvToHex(Cl.uint(selectedCommunityId)), cvToHex(Cl.principal(address))]),
      callReadOnly('get-last-entry-height', [cvToHex(Cl.uint(selectedCommunityId)), cvToHex(Cl.principal(address))]),
    ])

    const selectedPayload = extractResponseValue(selectedRead)
    const selectedTuple = asRecord(selectedPayload)
    const entryCount = asNumber(selectedTuple['entry-count'])

    const entryReads = await Promise.all(
      Array.from({ length: entryCount }, (_, idx) =>
        callReadOnly('get-entry', [cvToHex(Cl.uint(selectedCommunityId)), cvToHex(Cl.uint(idx + 1))]),
      ),
    )

    const nextEntries = entryReads
      .map((result, idx) => {
        const payload = extractResponseValue(result)
        if (!payload) return null
        const tuple = asRecord(payload)
        if (!tuple.author) return null
        return {
          id: idx + 1,
          author: asText(tuple.author),
          message: asText(tuple.message),
          createdHeight: asNumber(tuple['created-height']),
        } as Entry
      })
      .filter((item): item is Entry => Boolean(item))
      .sort((a, b) => b.id - a.id)

    setEntries(nextEntries)
    setCanSignNow(asBool(extractResponseValue(canSignRead)))
    setLastEntryHeight(asNumber(extractResponseValue(lastHeightRead)))
  }, [address, callReadOnly, selectedCommunityId])

  const refreshAll = useCallback(async () => {
    setLoading(true)
    try {
      await loadCommunities()
      setStatus('Communities refreshed')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to refresh communities')
    } finally {
      setLoading(false)
    }
  }, [loadCommunities])

  useEffect(() => {
    const cached = localStorage.getItem('guestbook-address')
    if (cached && isConnected()) setAddress(cached)
  }, [])

  useEffect(() => {
    if (!walletConnected) return
    refreshAll().catch(() => undefined)
  }, [refreshAll, walletConnected])

  useEffect(() => {
    if (!walletConnected || !selectedCommunityId) return
    loadSelectedCommunityData().catch(() => undefined)
  }, [loadSelectedCommunityData, selectedCommunityId, walletConnected])

  const onConnect = async () => {
    try {
      const response = await connect()
      const walletAddress = response.addresses[0].address
      setAddress(walletAddress)
      localStorage.setItem('guestbook-address', walletAddress)
      setStatus('Wallet connected')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Wallet connection failed')
    }
  }

  const onDisconnect = () => {
    disconnect()
    localStorage.removeItem('guestbook-address')
    setAddress('')
    setCommunities([])
    setSelectedCommunityId(null)
    setEntries([])
    setHistory([])
    setStatus('Wallet disconnected')
  }

  const onCreateCommunity = async () => {
    const name = newName.trim()
    const description = newDescription.trim()
    const rateLimit = Number(newRateLimit)

    if (!name || !description || !rateLimit) {
      setStatus('Name, description, and rate limit are required')
      return
    }

    setSubmitting(true)
    try {
      const response = await callTx('create-community', [Cl.stringUtf8(name), Cl.stringUtf8(description), Cl.uint(rateLimit)])
      const txid = (response as { txid?: string }).txid ?? 'submitted'
      addHistory(`Created community: ${name}`)
      setStatus(`create-community submitted: ${txid}`)
      setNewName('')
      setNewDescription('')
      await refreshAll()
    } catch (error) {
      setStatus(humanizeContractError(error))
    } finally {
      setSubmitting(false)
    }
  }

  const onSignGuestbook = async () => {
    if (!selectedCommunityId) {
      setStatus('Select a community first')
      return
    }

    const message = newMessage.trim()
    if (!message) {
      setStatus('Message is required')
      return
    }

    setSubmitting(true)
    try {
      const response = await callTx('sign-guestbook', [Cl.uint(selectedCommunityId), Cl.stringUtf8(message)])
      const txid = (response as { txid?: string }).txid ?? 'submitted'
      addHistory(`Signed guestbook #${selectedCommunityId}`)
      setStatus(`sign-guestbook submitted: ${txid}`)
      setNewMessage('')
      await refreshAll()
      await loadSelectedCommunityData()
    } catch (error) {
      setStatus(humanizeContractError(error))
    } finally {
      setSubmitting(false)
    }
  }

  const onToggleActive = async (active: boolean) => {
    if (!selectedCommunityId) return

    setSubmitting(true)
    try {
      const response = await callTx('set-community-active', [Cl.uint(selectedCommunityId), Cl.bool(active)])
      const txid = (response as { txid?: string }).txid ?? 'submitted'
      addHistory(`${active ? 'Reopened' : 'Paused'} community #${selectedCommunityId}`)
      setStatus(`set-community-active submitted: ${txid}`)
      await refreshAll()
    } catch (error) {
      setStatus(humanizeContractError(error))
    } finally {
      setSubmitting(false)
    }
  }

  const onSetRateLimit = async () => {
    if (!selectedCommunityId) return
    const nextRateLimit = Number(newOwnerRateLimit)
    if (!nextRateLimit) {
      setStatus('Rate limit must be a valid number')
      return
    }

    setSubmitting(true)
    try {
      const response = await callTx('set-rate-limit', [Cl.uint(selectedCommunityId), Cl.uint(nextRateLimit)])
      const txid = (response as { txid?: string }).txid ?? 'submitted'
      addHistory(`Updated rate limit for #${selectedCommunityId} to ${nextRateLimit}`)
      setStatus(`set-rate-limit submitted: ${txid}`)
      await refreshAll()
    } catch (error) {
      setStatus(humanizeContractError(error))
    } finally {
      setSubmitting(false)
    }
  }

  const shortAddress = walletConnected ? `${address.slice(0, 8)}...${address.slice(-6)}` : 'Disconnected'

  if (!walletConnected) {
    return (
      <main className="app locked-shell">
        <div className="shell">
          <header className="topbar">
            <div>
              <p className="eyebrow">Community Guestbook</p>
              <h1>On-Chain Message Walls</h1>
              <p className="muted">Connect wallet to unlock community creation, signing, and owner controls.</p>
            </div>
            <div className="actions">
              <button className="accent" onClick={onConnect}>
                Connect Wallet
              </button>
            </div>
          </header>

          <section className="locked hard-lock">
            <h2>UI Locked</h2>
            <p>The full guestbook dashboard is hidden until wallet connection succeeds.</p>
            <p className="muted small">Network: {NETWORK} | Contract: {contractId}</p>
          </section>

          <footer className="status">{status}</footer>
        </div>
      </main>
    )
  }

  return (
    <main className="app">
      <div className="shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">Community Guestbook</p>
            <h1>On-Chain Message Walls</h1>
            <p className="muted">Create spaces, sign guestbooks, and enforce cooldowns directly on Stacks.</p>
          </div>
          <div className="actions">
            <button className="ghost" onClick={() => refreshAll()} disabled={loading || submitting}>
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
            <button className="accent" onClick={onDisconnect}>
              Disconnect {shortAddress}
            </button>
          </div>
        </header>

        <section className="meta-row">
          <div className="meta-card">
            <span>Communities</span>
            <strong>{communities.length}</strong>
          </div>
          <div className="meta-card">
            <span>Selected</span>
            <strong>{selectedCommunity ? `${selectedCommunity.id} - ${selectedCommunity.name}` : 'None'}</strong>
          </div>
          <div className="meta-card">
            <span>Entries</span>
            <strong>{selectedCommunity?.entryCount ?? 0}</strong>
          </div>
          <div className="meta-card">
            <span>Can sign now</span>
            <strong>{canSignNow ? 'Yes' : 'Cooldown'}</strong>
          </div>
          <div className="meta-card">
            <span>Last signed block</span>
            <strong>{lastEntryHeight}</strong>
          </div>
          <div className="meta-card">
            <span>Wallet</span>
            <strong>{shortAddress}</strong>
          </div>
        </section>

        <div className="dashboard">
          <div className="stack">
            <section className="controls-panel dual-grid" aria-label="Create community">
              <label>
                Community name
                <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={64} placeholder="Builders Hub" />
              </label>
              <label>
                Description
                <input value={newDescription} onChange={(e) => setNewDescription(e.target.value)} maxLength={160} placeholder="Welcome to our guestbook" />
              </label>
              <label>
                Rate limit blocks
                <input value={newRateLimit} onChange={(e) => setNewRateLimit(e.target.value)} placeholder="10" />
              </label>
              <button className="accent" onClick={onCreateCommunity} disabled={submitting || loading}>
                Create community
              </button>
            </section>

            <section className="controls-panel deep-grid" aria-label="Sign and owner controls">
              <label className="wide-field">
                Sign selected community
                <input value={newMessage} onChange={(e) => setNewMessage(e.target.value)} maxLength={280} placeholder="Leave your on-chain message" />
              </label>
              <button className="accent" onClick={onSignGuestbook} disabled={submitting || loading || !selectedCommunity || !canSignNow || !selectedCommunity.active}>
                Sign guestbook
              </button>
              <label>
                Owner rate limit
                <input value={newOwnerRateLimit} onChange={(e) => setNewOwnerRateLimit(e.target.value)} placeholder="10" />
              </label>
              <button className="ghost" onClick={onSetRateLimit} disabled={submitting || loading || !isOwner || !selectedCommunity}>
                Set rate limit
              </button>
              <button className="ghost" onClick={() => onToggleActive(false)} disabled={submitting || loading || !isOwner || !selectedCommunity || !selectedCommunity.active}>
                Pause community
              </button>
              <button className="accent" onClick={() => onToggleActive(true)} disabled={submitting || loading || !isOwner || !selectedCommunity || selectedCommunity.active}>
                Reopen community
              </button>
            </section>

            <section className="poll-list category-grid" aria-label="Communities list">
              <div className="section-head">
                <h2>Communities</h2>
                <p className="muted small">Select a community to load feed and owner controls.</p>
              </div>
              <div className="category-cards">
                {communities.map((community, idx) => (
                  <article className="poll-card category-card" key={community.id} style={{ animationDelay: `${idx * 55}ms` }}>
                    <div className="poll-head">
                      <h3>
                        #{community.id} {community.name}
                      </h3>
                      <span className={community.active ? 'chip open' : 'chip closed'}>{community.active ? 'Active' : 'Paused'}</span>
                    </div>
                    <p className="muted small">Owner: {community.owner}</p>
                    <p>{community.description}</p>
                    <p className="muted small">
                      Rate: {community.rateLimitBlocks} blocks | Entries: {community.entryCount}
                    </p>
                    <div className="poll-foot">
                      <button className="ghost" onClick={() => setSelectedCommunityId(community.id)}>
                        View feed
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </div>

          <div className="stack">
            <section className="poll-list history-list" aria-label="Guestbook feed">
              <div className="section-head">
                <h2>Guestbook Feed {selectedCommunity ? `#${selectedCommunity.id}` : ''}</h2>
                {selectedCommunity && !selectedCommunity.active ? (
                  <p className="muted small">This community is paused. Signing is disabled.</p>
                ) : null}
              </div>
              {entries.length === 0 ? (
                <p className="muted">No entries yet.</p>
              ) : (
                <div className="history-items">
                  {entries.map((entry) => (
                    <article className="poll-card history-card" key={`${entry.id}-${entry.author}`}>
                      <div className="poll-head">
                        <h3>Entry #{entry.id}</h3>
                        <span className="chip closed">Block {entry.createdHeight}</span>
                      </div>
                      <p>{entry.message}</p>
                      <p className="muted small">By {entry.author}</p>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="poll-list history-list" aria-label="Recent local activity">
              <div className="section-head">
                <h2>Recent Local Activity</h2>
              </div>
              {history.length === 0 ? (
                <p className="muted">No actions yet.</p>
              ) : (
                <div className="history-items">
                  {history.map((item, idx) => (
                    <article className="poll-card history-card" key={`${item}-${idx}`}>
                      <p>{item}</p>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>

        <footer className="status">{status}</footer>
      </div>
    </main>
  )
}

export default App
