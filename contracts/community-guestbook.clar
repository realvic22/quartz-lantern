;; Community guestbook with per-community posting cooldown.

(define-constant MIN-RATE-LIMIT u1)
(define-constant MAX-RATE-LIMIT u1440)

(define-constant ERR-COMMUNITY-NOT-FOUND (err u100))
(define-constant ERR-COMMUNITY-INACTIVE (err u101))
(define-constant ERR-RATE-LIMIT (err u102))
(define-constant ERR-NOT-OWNER (err u103))
(define-constant ERR-BAD-RATE-LIMIT (err u104))

(define-data-var community-nonce uint u0)

(define-map communities
  uint
  {
    owner: principal,
    name: (string-utf8 64),
    description: (string-utf8 160),
    rate-limit-blocks: uint,
    active: bool,
    created-height: uint,
    entry-count: uint,
  }
)

(define-map entries
  {
    community-id: uint,
    entry-id: uint,
  }
  {
    author: principal,
    message: (string-utf8 280),
    created-height: uint,
  }
)

(define-map last-entry-height
  {
    community-id: uint,
    user: principal,
  }
  uint
)

(define-private (is-valid-rate-limit (rate-limit uint))
  (and (>= rate-limit MIN-RATE-LIMIT) (<= rate-limit MAX-RATE-LIMIT))
)

(define-public
  (create-community
    (name (string-utf8 64))
    (description (string-utf8 160))
    (rate-limit-blocks uint))
  (begin
    (asserts! (is-valid-rate-limit rate-limit-blocks) ERR-BAD-RATE-LIMIT)
    (let ((next-id (+ (var-get community-nonce) u1)))
      (var-set community-nonce next-id)
      (map-set communities
        next-id
        {
          owner: tx-sender,
          name: name,
          description: description,
          rate-limit-blocks: rate-limit-blocks,
          active: true,
          created-height: burn-block-height,
          entry-count: u0,
        }
      )
      (print {
        event: "community-created",
        community-id: next-id,
        owner: tx-sender,
      })
      (ok next-id)
    )
  )
)

(define-public (sign-guestbook (community-id uint) (message (string-utf8 280)))
  (let (
      (community (unwrap! (map-get? communities community-id) ERR-COMMUNITY-NOT-FOUND))
      (last-height (default-to u0 (map-get? last-entry-height { community-id: community-id, user: tx-sender })))
      (entry-id (+ (get entry-count community) u1))
      (required-height (+ last-height (get rate-limit-blocks community)))
    )
    (asserts! (get active community) ERR-COMMUNITY-INACTIVE)
    (asserts! (or (is-eq last-height u0) (>= burn-block-height required-height)) ERR-RATE-LIMIT)

    (map-set entries
      { community-id: community-id, entry-id: entry-id }
      {
        author: tx-sender,
        message: message,
        created-height: burn-block-height,
      }
    )

    (map-set last-entry-height { community-id: community-id, user: tx-sender } burn-block-height)

    (map-set communities
      community-id
      {
        owner: (get owner community),
        name: (get name community),
        description: (get description community),
        rate-limit-blocks: (get rate-limit-blocks community),
        active: (get active community),
        created-height: (get created-height community),
        entry-count: entry-id,
      }
    )

    (print {
      event: "guestbook-signed",
      community-id: community-id,
      entry-id: entry-id,
      author: tx-sender,
    })

    (ok entry-id)
  )
)

(define-public (set-community-active (community-id uint) (is-active bool))
  (let ((community (unwrap! (map-get? communities community-id) ERR-COMMUNITY-NOT-FOUND)))
    (asserts! (is-eq tx-sender (get owner community)) ERR-NOT-OWNER)
    (map-set communities
      community-id
      {
        owner: (get owner community),
        name: (get name community),
        description: (get description community),
        rate-limit-blocks: (get rate-limit-blocks community),
        active: is-active,
        created-height: (get created-height community),
        entry-count: (get entry-count community),
      }
    )
    (ok true)
  )
)

(define-public (set-rate-limit (community-id uint) (new-rate-limit uint))
  (begin
    (asserts! (is-valid-rate-limit new-rate-limit) ERR-BAD-RATE-LIMIT)
    (let ((community (unwrap! (map-get? communities community-id) ERR-COMMUNITY-NOT-FOUND)))
      (asserts! (is-eq tx-sender (get owner community)) ERR-NOT-OWNER)
      (map-set communities
        community-id
        {
          owner: (get owner community),
          name: (get name community),
          description: (get description community),
          rate-limit-blocks: new-rate-limit,
          active: (get active community),
          created-height: (get created-height community),
          entry-count: (get entry-count community),
        }
      )
      (ok true)
    )
  )
)

(define-read-only (get-community (community-id uint))
  (ok (map-get? communities community-id))
)

(define-read-only (get-community-count)
  (ok (var-get community-nonce))
)

(define-read-only (get-entry (community-id uint) (entry-id uint))
  (ok (map-get? entries { community-id: community-id, entry-id: entry-id }))
)

(define-read-only (get-last-entry-height (community-id uint) (who principal))
  (ok (default-to u0 (map-get? last-entry-height { community-id: community-id, user: who })))
)

(define-read-only (can-sign-now (community-id uint) (who principal))
  (let ((community (unwrap! (map-get? communities community-id) ERR-COMMUNITY-NOT-FOUND)))
    (if (not (get active community))
      (ok false)
      (let (
          (last-height (default-to u0 (map-get? last-entry-height { community-id: community-id, user: who })))
          (required-height (+ (default-to u0 (map-get? last-entry-height { community-id: community-id, user: who })) (get rate-limit-blocks community)))
        )
        (ok (or (is-eq last-height u0) (>= burn-block-height required-height)))
      )
    )
  )
)
