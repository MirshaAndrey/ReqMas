import { useState } from 'react'
import type { CSSProperties, DragEvent } from 'react'
import type { Collection, History, Request } from '../types/request'
import { buildFolderTree, flattenFolderTree, folderMatchesSearch, navigationMatches } from '../services/navigation'
import type { FolderNode } from '../services/navigation'
import { read, write } from '../storage/database'
import '../navigation.css'

type Props = {
  collections: Collection[]; requests: Request[]; history: History[]; selectedId: string; section: string; search: string; busy: boolean
  onSection: (section: string) => void; onSearch: (search: string) => void; onSelect: (request: Request) => void
  onNew: (collectionId?: string) => void; onDelete: (request: Request) => void; onCollection: (collection?: Collection) => void
  onImport: () => void; onOpenApi: () => void; onClearHistory: () => void
  onHistory: (history: History) => void
  onMoveRequest: (requestId: string, collectionId: string, folder: string, beforeRequestId?: string) => void
  onMoveCollection: (collectionId: string, beforeCollectionId?: string) => void
}
type DragItem = { kind: 'request' | 'collection'; id: string }
type MoveItem = { id: string; collectionId: string; folder: string }
const dragMime = 'application/x-reqmas-navigation'
const nodeKey = (collectionId: string, folder?: string) => JSON.stringify([collectionId, folder ?? null])
function readCollapsed() {
  try { const value: unknown = read('navigationCollapsed', []); return new Set<string>(Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []) }
  catch { return new Set<string>() }
}

export function Sidebar(p: Props) {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [dragging, setDragging] = useState<DragItem | null>(null), [dropTarget, setDropTarget] = useState('')
  const [moving, setMoving] = useState<MoveItem | null>(null), [movingCollection, setMovingCollection] = useState('')
  const search = p.search.trim().toLocaleLowerCase()
  const matches = (request: Request, collection: Collection) => navigationMatches(request, collection.name, search)
  const toggle = (key: string) => setCollapsed(previous => {
    const next = new Set(previous)
    if (next.has(key)) next.delete(key); else next.add(key)
    try { write('navigationCollapsed', [...next]) } catch { /* Navigation still works if preference storage is full. */ }
    return next
  })
  const startDrag = (event: DragEvent, item: DragItem) => {
    if (p.busy) { event.preventDefault(); return }
    event.stopPropagation(); event.dataTransfer.setData(dragMime, JSON.stringify(item)); event.dataTransfer.effectAllowed = 'move'; setDragging(item)
  }
  const over = (event: DragEvent, key: string, kind: DragItem['kind'] | 'either') => {
    if (p.busy || !dragging || kind !== 'either' && dragging.kind !== kind) return
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setDropTarget(key)
  }
  const drop = (event: DragEvent, collectionId: string, folder: string, beforeRequestId?: string, beforeCollectionId?: string) => {
    event.preventDefault(); event.stopPropagation()
    try {
      const item: DragItem = JSON.parse(event.dataTransfer.getData(dragMime))
      if (!p.busy && item.kind === 'request' && p.requests.some(request => request.id === item.id)) p.onMoveRequest(item.id, collectionId, folder, beforeRequestId)
      if (!p.busy && item.kind === 'collection' && !beforeRequestId && !folder && p.collections.some(collection => collection.id === item.id)) p.onMoveCollection(item.id, beforeCollectionId)
    } catch { /* Ignore foreign or incomplete drag data. */ }
    setDragging(null); setDropTarget('')
  }
  return <aside className="sidebar">
    <a className="brand" href="/" aria-label="Reqmas home"><span className="brand-icon" aria-hidden="true">&gt;_</span><span className="brand-name">Reqmas</span><span className="version">BETA</span></a>
    <div className="workspace-label"><span className="avatar">P</span><div>Personal workspace<small>Local workspace</small></div><span className="local-dot" /></div>
    <div className="side-tabs">{['Collections', 'History'].map(section => <button key={section} className={p.section === section ? 'active' : ''} onClick={() => p.onSection(section)}>{section === 'Collections' ? '▤' : '◷'} {section}</button>)}</div>
    <div className="search"><span>⌕</span><input data-request-search aria-label="Search requests" placeholder="Search requests..." value={p.search} onChange={event => p.onSearch(event.target.value)} /><kbd title="Search requests">⌃K</kbd></div>
    <button className="import-button" disabled={p.busy} onClick={p.onImport}>↓ Import from Postman</button>
    <button className="import-button" disabled={p.busy} onClick={p.onOpenApi}>↓ Import OpenAPI / Swagger</button>
    <div className="side-heading">{p.section.toUpperCase()}<button disabled={p.busy} aria-label="New collection" onClick={() => p.onCollection()}>+</button></div>
    <div className="tree navigation-tree" aria-label={p.section === 'Collections' ? 'Collections and requests' : 'Request history'}>{p.section === 'Collections' ? <>
      <p className="navigation-hint">Drag to organize · ⋯ for move options</p>
      {p.collections.map(renderCollection)}
      {search && !p.requests.some(request => { const collection = p.collections.find(item => item.id === request.collectionId); return collection && matches(request, collection) }) && !p.collections.some(collection => collection.name.toLocaleLowerCase().includes(search) || flattenFolderTree(buildFolderTree(collection.folders ?? [], p.requests.filter(request => request.collectionId === collection.id))).some(folder => folder.toLocaleLowerCase().includes(search))) && <p className="muted side-empty">No matching requests.</p>}
      {dragging?.kind === 'collection' && <div className={`navigation-drop-end ${dropTarget === 'collection-end' ? 'navigation-drop-active' : ''}`} onDragOver={event => over(event, 'collection-end', 'collection')} onDrop={event => drop(event, '', '')}>Move collection to end</div>}
    </> : <>
      {p.history.length === 0 && <p className="muted side-empty">Your sent requests will appear here.</p>}
      {p.history.filter(history => `${history.request.name} ${history.request.url}`.toLocaleLowerCase().includes(search)).map(history => <button className="history-item" key={history.id} onClick={() => p.onHistory(history)}><span className={`method ${history.request.method.toLowerCase()}`}>{history.request.method}</span><span>{history.request.name}<small>{new Date(history.time).toLocaleTimeString()} · {history.status} · {history.duration} ms {history.response ? '· saved response' : ''}</small></span></button>)}
      {p.history.length > 0 && <button className="clear-history" onClick={p.onClearHistory}>Clear history</button>}
    </>}</div>
    <button disabled={p.busy} className="new-request" onClick={() => p.onNew()}>+ <span>New request</span></button>
    <div className="sidebar-bottom"><span className="local-dot" /> Stored on this device</div>
  </aside>

  function renderCollection(collection: Collection, index: number) {
    const requests = p.requests.filter(request => request.collectionId === collection.id)
    const tree = buildFolderTree(collection.folders ?? [], requests), paths = flattenFolderTree(tree)
    if (search && !collection.name.toLocaleLowerCase().includes(search) && !requests.some(request => matches(request, collection)) && !paths.some(path => path.toLocaleLowerCase().includes(search))) return null
    const key = nodeKey(collection.id), expanded = !!search || !collapsed.has(key)
    return <section key={collection.id} className="collection navigation-collection">
      <div className={`collection-title ${dropTarget === key ? 'navigation-drop-active' : ''}`} draggable={!p.busy} onDragStart={event => startDrag(event, { kind: 'collection', id: collection.id })} onDragEnd={() => { setDragging(null); setDropTarget('') }} onDragOver={event => over(event, key, 'either')} onDrop={event => drop(event, collection.id, '', undefined, collection.id)}>
        <button className="navigation-toggle" aria-disabled={!!search} title={search ? 'Clear search to collapse this collection' : undefined} aria-label={`${expanded ? 'Collapse' : 'Expand'} collection ${collection.name}`} aria-expanded={expanded} onClick={() => { if (!search) toggle(key) }}><span aria-hidden>{expanded ? '⌄' : '›'}</span><span aria-hidden>▱</span><span className="collection-name">{collection.name}</span></button>
        <div className="collection-actions"><button disabled={p.busy} aria-label={`Reorder collection ${collection.name}`} aria-expanded={movingCollection === collection.id} title="Reorder collection" onClick={() => setMovingCollection(movingCollection === collection.id ? '' : collection.id)}>⋯</button><button disabled={p.busy} aria-label={`Manage ${collection.name}`} title="Collection settings" onClick={() => p.onCollection(collection)}>⚙</button><button disabled={p.busy} aria-label={`New request in ${collection.name}`} title="New request" onClick={() => p.onNew(collection.id)}>+</button></div>
      </div>
      {movingCollection === collection.id && <div className="navigation-order-panel"><button disabled={p.busy || index === 0} aria-label={`Move collection ${collection.name} up`} onClick={() => p.onMoveCollection(collection.id, p.collections[index - 1].id)}>↑ Move up</button><button disabled={p.busy || index === p.collections.length - 1} aria-label={`Move collection ${collection.name} down`} onClick={() => p.onMoveCollection(collection.id, p.collections[index + 2]?.id)}>↓ Move down</button><button aria-label={`Close reorder options for ${collection.name}`} onClick={() => setMovingCollection('')}>×</button></div>}
      {expanded && <div className="navigation-collection-content">
        {dragging?.kind === 'request' && <div className={`navigation-root-drop ${dropTarget === key + ':root' ? 'navigation-drop-active' : ''}`} onDragOver={event => over(event, key + ':root', 'request')} onDrop={event => drop(event, collection.id, '')}>Drop at collection root</div>}
        {renderRequests(collection, '', requests)}
        {tree.map(node => renderFolder(collection, node, requests, 0))}
        {!search && !requests.length && <button className="empty-collection" disabled={p.busy} onClick={() => p.onNew(collection.id)}>+ Add your first request</button>}
      </div>}
    </section>
  }

  function renderFolder(collection: Collection, node: FolderNode, requests: Request[], depth: number) {
    if (!folderMatchesSearch(node, requests, collection.name, search)) return null
    const key = nodeKey(collection.id, node.path), expanded = !!search || !collapsed.has(key)
    return <div className="navigation-folder" key={node.path} style={{ '--folder-indent': depth < 8 ? '10px' : '0px', '--folder-border': depth < 8 ? '1px' : '0px' } as CSSProperties}>
      <button className={`navigation-folder-title ${dropTarget === key ? 'navigation-drop-active' : ''}`} aria-disabled={!!search} title={search ? `${node.path} · Clear search to collapse` : node.path} aria-label={`${expanded ? 'Collapse' : 'Expand'} folder ${node.path} in ${collection.name}`} aria-expanded={expanded} onClick={() => { if (!search) toggle(key) }} onDragOver={event => over(event, key, 'request')} onDrop={event => drop(event, collection.id, node.path)}><span aria-hidden>{expanded ? '⌄' : '›'}</span><span aria-hidden>▱</span><span>{node.name}</span></button>
      {expanded && <div className="navigation-folder-content">{renderRequests(collection, node.path, requests)}{node.children.map(child => renderFolder(collection, child, requests, depth + 1))}</div>}
    </div>
  }

  function renderRequests(collection: Collection, folder: string, requests: Request[]) {
    const siblings = requests.filter(request => (request.folder ?? '') === folder)
    return siblings.filter(request => matches(request, collection)).map(request => {
      const index = siblings.findIndex(sibling => sibling.id === request.id), key = 'request:' + request.id
      const destination = p.collections.find(item => item.id === moving?.collectionId)
      const destinationPaths = destination ? flattenFolderTree(buildFolderTree(destination.folders ?? [], p.requests.filter(item => item.collectionId === destination.id))) : []
      const destinationFolder = moving?.folder && destinationPaths.includes(moving.folder) ? moving.folder : ''
      return <div key={request.id} className="navigation-request">
        <div className={`request-row ${p.selectedId === request.id ? 'selected' : ''} ${dropTarget === key ? 'navigation-insert-active' : ''}`} draggable={!p.busy} onDragStart={event => startDrag(event, { kind: 'request', id: request.id })} onDragEnd={() => { setDragging(null); setDropTarget('') }} onDragOver={event => over(event, key, 'request')} onDrop={event => drop(event, collection.id, folder, request.id)}>
          <button className="request-item" title={`${request.method} ${request.url}`} onClick={() => p.onSelect(request)}><span className={`method ${request.method.toLowerCase()}`}>{request.method}</span><span className="request-label">{request.name}</span></button>
          <button disabled={p.busy} className="row-action" aria-label={`Move ${request.name}`} aria-expanded={moving?.id === request.id} title="Move or reorder request" onClick={() => setMoving(moving?.id === request.id ? null : { id: request.id, collectionId: collection.id, folder })}>⋯</button>
          <button disabled={p.busy} className="row-action danger-text" aria-label={`Delete ${request.name}`} title="Delete request" onClick={() => p.onDelete(request)}>×</button>
        </div>
        {moving?.id === request.id && <form className="navigation-move-panel" aria-label={`Move options for ${request.name}`} onSubmit={event => { event.preventDefault(); if (destination && !p.busy) { p.onMoveRequest(request.id, destination.id, destinationFolder); setMoving(null) } }}>
          <div className="navigation-order-panel"><button type="button" disabled={p.busy || index === 0} aria-label={`Move ${request.name} up`} onClick={() => p.onMoveRequest(request.id, collection.id, folder, siblings[index - 1].id)}>↑ Move up</button><button type="button" disabled={p.busy || index === siblings.length - 1} aria-label={`Move ${request.name} down`} onClick={() => p.onMoveRequest(request.id, collection.id, folder, siblings[index + 2]?.id)}>↓ Move down</button></div>
          <label>Collection<select aria-label={`Destination collection for ${request.name}`} disabled={p.busy} value={moving.collectionId} onChange={event => setMoving({ ...moving, collectionId: event.target.value, folder: '' })}>{p.collections.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Folder<select aria-label={`Destination folder for ${request.name}`} disabled={p.busy || !destination} value={destinationFolder} onChange={event => setMoving({ ...moving, folder: event.target.value })}><option value="">Collection root</option>{destinationPaths.map(path => <option key={path} value={path}>{path}</option>)}</select></label>
          <div className="navigation-move-actions"><button type="button" onClick={() => setMoving(null)}>Cancel</button><button className="save" type="submit" disabled={p.busy || !destination}>Move request</button></div>
        </form>}
      </div>
    })
  }
}
