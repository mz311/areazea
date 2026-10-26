fx_version 'cerulean'
game 'gta5'

name 'fbm-updater'
author 'FiveM Base Manager'
description 'Mises à jour de la base depuis la console txAdmin ou en jeu (commande fbm)'
version '1.0.0'

-- Node 22 sur les artifacts récents ; le code reste compatible avec Node 16 (artifacts plus anciens).
node_version '22'

-- engine.js d'abord : il définit globalThis.FBM utilisé par main.js
server_scripts {
    'server/engine.js',
    'server/main.js',
}
