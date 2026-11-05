// Globales que app.js usa y que no vienen en lib.dom.

/** Controlador de @dotrino/notifications, lo cablea el <script type="module"> de index.html. */
interface GymbroNotifications {
  requestPermission(): Promise<unknown>
  notify(category: string, opts: NotificationOptions & { title: string, body: string, renotify?: boolean, vibrate?: number[] }): Promise<unknown>
}

interface Window {
  __ccNotif?: GymbroNotifications
  /** Safari viejo. */
  webkitAudioContext?: typeof AudioContext
}
