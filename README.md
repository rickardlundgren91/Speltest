# ABC2 – speltest

ABC2 som vanlig webbsida (GitHub Pages), så multiplayer kan gå P2P med WebRTC. I claude.ai är WebRTC blockerat och matcher går via live-rummet.

- Spela: https://rickardlundgren91.github.io/Speltest/
- Multiplayer 1v1: den ena trycker SKAPA MATCH och får en kod, den andra skriver koden och trycker ANSLUT.
- Uppkopplingen hittas via PeerJS gratis-broker (0.peerjs.com). Själva matchen går direkt mellan enheterna.
- Källan ligger i projektmappen abc2/ (samma filer som artefakten ABC2-game). `peerjs.min.js` är PeerJS 1.5.4 (MIT).

