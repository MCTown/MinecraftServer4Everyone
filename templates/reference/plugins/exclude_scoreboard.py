from mcdreforged.api.all import *

PLUGIN_METADATA = {
    'id': 'exclude_scoreboard',
    'version': '0.1.0',
    'name': 'Exclude Scoreboard',
    'author': 'xiaoyu2006'
}


# def on_load(server, old):
#     server.logger.info('Exclude Scoreboard loaded')
def on_player_joined(server: PluginServerInterface, player: str, info: Info):
    if player.lower().startswith('__'):
        server.execute('team join bot ' + player)

def on_player_left(server, player):
    if player.lower().startswith('__'):
        server.execute('scoreboard players reset ' + player)
        server.logger.info('Excluded player {} from scoreboard'.format(player))

