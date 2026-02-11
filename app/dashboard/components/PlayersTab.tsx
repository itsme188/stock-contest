import { type Player } from "@/lib/contest";

interface PlayersTabProps {
  players: Player[];
  editingPlayer: string | null;
  setEditingPlayer: (id: string | null) => void;
  showAddPlayer: boolean;
  setShowAddPlayer: (show: boolean) => void;
  newPlayerName: string;
  setNewPlayerName: (name: string) => void;
  addPlayer: () => void;
  updatePlayerName: (id: string, newName: string) => void;
  deletePlayer: (id: string) => void;
}

export default function PlayersTab({
  players,
  editingPlayer,
  setEditingPlayer,
  showAddPlayer,
  setShowAddPlayer,
  newPlayerName,
  setNewPlayerName,
  addPlayer,
  updatePlayerName,
  deletePlayer,
}: PlayersTabProps) {
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold text-gray-900">Players</h2>
        <button
          onClick={() => setShowAddPlayer(true)}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          + Add Player
        </button>
      </div>

      {/* Add Player Modal */}
      {showAddPlayer && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-sm mx-4">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">
              Add Player
            </h3>
            <input
              type="text"
              value={newPlayerName}
              onChange={(e) => setNewPlayerName(e.target.value)}
              placeholder="Player name"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && addPlayer()}
            />
            <div className="flex gap-3 mt-4">
              <button
                onClick={() => setShowAddPlayer(false)}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={addPlayer}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Player List */}
      <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
        {players.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-gray-500">No players added yet</p>
          </div>
        ) : (
          players.map((player) => (
            <div
              key={player.id}
              className="px-6 py-4 flex items-center gap-4"
            >
              <span
                className="w-4 h-4 rounded-full"
                style={{ backgroundColor: player.color }}
              />
              {editingPlayer === player.id ? (
                <input
                  type="text"
                  defaultValue={player.name}
                  autoFocus
                  className="flex-1 px-2 py-1 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                  onBlur={(e) =>
                    updatePlayerName(player.id, e.target.value)
                  }
                  onKeyDown={(e) =>
                    e.key === "Enter" &&
                    updatePlayerName(
                      player.id,
                      (e.target as HTMLInputElement).value
                    )
                  }
                />
              ) : (
                <span className="flex-1 font-medium text-gray-900">
                  {player.name}
                </span>
              )}
              <button
                onClick={() => setEditingPlayer(player.id)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                Edit
              </button>
              <button
                onClick={() => deletePlayer(player.id)}
                className="text-gray-400 hover:text-red-600 transition-colors"
              >
                Delete
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
