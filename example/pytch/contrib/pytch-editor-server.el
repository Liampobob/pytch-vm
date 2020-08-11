(require 'websocket)
(require 'json)

(setq live-ws nil)

(setq my-websocket-server
      (websocket-server
       4111
       :host 'local
       :on-message (lambda (ws frame)
                     (message "received message through websocket"))
       :on-open (lambda (ws)
                  (message "got connection")
                  (if live-ws
                      (websocket-close live-ws))
                  (setq live-ws ws))
       :on-close (lambda (ws)
                   (message "websocket closed")
                   (setq live-ws nil))))

(defun pytch-maybe-send-code ()
  (interactive)
  (save-buffer)
  (if live-ws
      (let ((msg-hash (make-hash-table)))
        (puthash "code" (buffer-string) msg-hash)
        (let ((msg-json (json-encode msg-hash)))
          (websocket-send-text live-ws msg-json)))
    (message "(No websocket client)")))


(global-set-key (kbd "<f5>") 'pytch-maybe-send-code)
