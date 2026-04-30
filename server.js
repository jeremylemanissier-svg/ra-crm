(async function() {
  const MAP = {
    'Simon': 'Simon DAVID',
    'Antoine': 'Antoine DUPONT',
    'Anne-Sophie': 'Anne-Sophie EYANGO',
    'Shirley': 'Shirley GOSSELIN',
    'Jérémy': 'Jérémy LEMANISSIER',
    'Jeremy': 'Jérémy LEMANISSIER',
    'Hugo': 'Hugo BOURBIER',
    'Clemence': 'Clémence',
    'Clémence': 'Clémence'
  };

  function migrate(val) {
    return MAP[val] || val;
  }

  let total = 0;

  // === CANDIDATS ===
  const rCands = await fetch('/api/data/candidats');
  const candidats = await rCands.json();
  let cCount = 0;
  const newCands = candidats.map(c => {
    const old = c.cons;
    const updated = migrate(c.cons);
    if (old !== updated) { cCount++; return { ...c, cons: updated }; }
    return c;
  });
  await fetch('/api/data/candidats', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newCands) });
  total += cCount;
  console.log(`✅ Candidats : ${cCount} mis à jour`);

  // === CLIENTS ===
  const rClients = await fetch('/api/data/clients');
  const clients = await rClients.json();
  let clCount = 0;
  const newClients = clients.map(c => {
    const updated = migrate(c.cons);
    if (c.cons !== updated) { clCount++; return { ...c, cons: updated }; }
    return c;
  });
  await fetch('/api/data/clients', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newClients) });
  total += clCount;
  console.log(`✅ Clients : ${clCount} mis à jour`);

  // === COMMANDES ===
  const rCmds = await fetch('/api/data/commandes');
  const commandes = await rCmds.json();
  let cmdCount = 0;
  const newCmds = commandes.map(c => {
    const updated = migrate(c.cons);
    if (c.cons !== updated) { cmdCount++; return { ...c, cons: updated }; }
    return c;
  });
  await fetch('/api/data/commandes', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newCmds) });
  total += cmdCount;
  console.log(`✅ Commandes : ${cmdCount} mises à jour`);

  // === ACTIONS ===
  const rActions = await fetch('/api/data/actions');
  const actions = await rActions.json();
  let actCount = 0;
  const newActions = actions.map(a => {
    const updated = migrate(a.cons);
    if (a.cons !== updated) { actCount++; return { ...a, cons: updated }; }
    return a;
  });
  await fetch('/api/data/actions', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newActions) });
  total += actCount;
  console.log(`✅ Actions : ${actCount} mises à jour`);

  alert(`✅ Migration terminée !\n\nCandidats : ${cCount}\nClients : ${clCount}\nCommandes : ${cmdCount}\nActions : ${actCount}\n\nTotal : ${total} enregistrements mis à jour.\n\nRechargez la page (F5).`);
})();
