import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const OTC_ROWS = [
  ['0.1.1.a', 'Plaque immatriculation manquante ou risque de chute', 'M', 'Identification'],
  ['0.1.1.b', 'Inscription plaque manquante ou illisible', 'M', 'Identification'],
  ['0.1.1.c', 'Plaque ne correspond pas aux documents', 'M', 'Identification'],
  ['0.1.1.d', 'Plaque non conforme', 'M', 'Identification'],
  ['0.2.1.a', 'Numero identification manquant', 'M', 'Identification'],
  ['0.2.1.b', 'Numero incomplet, illisible ou falsifie', 'M', 'Identification'],
  ['0.4.1.b', 'Non-concordance energie/document', 'M', 'Identification'],
  ['0.4.1.c', 'Modification necessitant mise en conformite', 'M', 'Identification'],
  ['1.1.1.a', 'Pivot pedale frein trop serre', 'M', 'Freinage'],
  ['1.1.1.b', 'Pivot pedale frein : usure ou jeu', 'M', 'Freinage'],
  ['1.1.2.a', 'Course pedale trop grande / reserve insuffisante', 'M', 'Freinage'],
  ['1.1.2.b', 'Degagement frein difficile', 'M', 'Freinage'],
  ['1.1.2.c', 'Caoutchouc pedale manquant/use', 'M', 'Freinage'],
  ['1.1.6.a', 'Frein stationnement : verrouillage insuffisant', 'M', 'Frein stationnement'],
  ['1.1.6.b', 'Frein stationnement : usure axe levier', 'M', 'Frein stationnement'],
  ['1.1.6.c', 'Frein stationnement : course trop longue', 'M', 'Frein stationnement'],
  ['1.1.6.d', 'Frein stationnement : actionneur manquant/defaillant', 'M', 'Frein stationnement'],
  ['1.1.10.a', 'Dispositif freinage assiste defectueux', 'M', 'Freinage'],
  ['1.1.10.b', 'Maitre-cylindre defectueux', 'M', 'Freinage'],
  ['1.1.10.c', 'Fixation maitre-cylindre insuffisante', 'M', 'Freinage'],
  ['1.1.10.d', 'Niveau liquide frein sous MIN', 'M', 'Freinage'],
  ['1.1.10.e', 'Reservoir maitre-cylindre deteriore', 'M', 'Freinage'],
  ['1.1.11.c', 'Conduites rigides : endommagement/corrosion', 'M', 'Freinage'],
  ['1.1.12.b', 'Flexibles frein endommages/frottant', 'M', 'Freinage'],
  ['1.1.12.d', 'Gonflement excessif flexible', 'M', 'Freinage'],
  ['1.1.12.e', 'Flexibles poreux', 'M', 'Freinage'],
  ['1.1.13.a', 'Usure garnitures/plaquettes (marque MIN atteinte)', 'M', 'Freinage'],
  ['1.1.13.b', 'Garnitures encrassees (huile/graisse)', 'M', 'Freinage'],
  ['1.1.14.a', 'Disque ou tambour use', 'M', 'Freinage'],
  ['1.1.14.b', 'Tambour/disque encrasse (huile/graisse)', 'M', 'Freinage'],
  ['1.1.15.a', 'Cable frein endommage / flambage', 'M', 'Freinage'],
  ['1.1.15.b', 'Cable frein : usure/corrosion avancee', 'M', 'Freinage'],
  ['1.1.16.a', 'Cylindre/etrier fissure ou endommage', 'M', 'Freinage'],
  ['1.1.16.b', 'Cylindre/etrier : etancheite insuffisante', 'M', 'Freinage'],
  ['1.1.16.d', 'Cylindre/etrier : corrosion excessive', 'M', 'Freinage'],
  ['1.2.1.a', 'Frein service : freinage insuffisant sur une roue', 'M', 'Freinage'],
  ['1.2.1.b', 'Frein service : desequilibre notable', 'M', 'Freinage'],
  ['1.2.2.a', 'Frein service : efficacite insuffisante', 'M', 'Freinage'],
  ['1.3.1.a', 'Frein secours : freinage insuffisant', 'M', 'Frein secours'],
  ['1.3.2.a', 'Frein secours : efficacite insuffisante', 'M', 'Frein secours'],
  ['1.4.2.a', 'Frein stationnement : efficacite insuffisante', 'M', 'Frein stationnement'],
  ['1.6.1.a', 'ABS : mauvais fonctionnement dispositif alerte', 'M', 'ABS'],
  ['1.6.1.b', 'ABS : defaillance indiquee par le systeme', 'M', 'ABS'],
  ['1.6.1.c', 'ABS : capteur vitesse manquant/endommage', 'M', 'ABS'],
  ['1.6.1.f', 'ABS : defaillance via interface electronique', 'M', 'ABS'],
  ['1.8.1.a', 'Liquide frein contamine/sedimente', 'M', 'Freinage'],
  ['2.1.1.a', 'Boitier direction : conduite dure', 'M', 'Direction'],
  ['2.1.1.b', 'Boitier direction : axe tordu/cannelures usees', 'M', 'Direction'],
  ['2.1.2.a', 'Fixation boitier/cremaillere mauvaise', 'M', 'Direction'],
  ['2.1.3.a', 'Timonerie : jeu entre organes fixes', 'M', 'Direction'],
  ['2.1.3.b', 'Timonerie : usure excessive articulations', 'M', 'Direction'],
  ['2.1.3.c', 'Timonerie : felure/deformation element', 'M', 'Direction'],
  ['2.1.3.g', 'Timonerie : capuchon antipoussiere manquant', 'M', 'Direction'],
  ['2.1.5.a', 'Direction assistee : fuite liquide', 'M', 'Direction assistee'],
  ['2.1.5.b', 'Direction assistee : niveau insuffisant', 'm', 'Direction assistee'],
  ['2.1.5.c', 'Direction assistee : mecanisme inoperant', 'M', 'Direction assistee'],
  ['2.2.1.a', 'Volant : mouvement relatif volant/colonne', 'M', 'Direction'],
  ['2.2.1.b', 'Volant : absence dispositif retenue moyeu', 'M', 'Direction'],
  ['2.2.2.a', 'Colonne : mouvement excessif', 'M', 'Direction'],
  ['2.2.2.d', 'Colonne : mauvaise fixation', 'M', 'Direction'],
  ['2.3.1.a', 'Jeu direction excessif', 'M', 'Direction'],
  ['2.6.1.a', 'Direction assistee electronique : defaillance', 'M', 'Direction assistee'],
  ['2.6.1.b', 'Incoherence angle volant/roues', 'M', 'Direction assistee'],
  ['2.6.1.c', 'Assistance ne fonctionne pas', 'M', 'Direction assistee'],
  ['3.1.1.a', 'Obstruction champ vision conducteur', 'M', 'Visibilite'],
  ['3.2.1.a', 'Pare-brise fissure/decolore zone balayage', 'M', 'Vitrage'],
  ['3.2.1.b', 'Pare-brise/vitre laterale avant non conforme', 'M', 'Vitrage'],
  ['3.3.1.a', 'Retroviseur manquant ou mal fixe', 'M', 'Retroviseurs'],
  ['3.3.1.b', 'Retroviseur endommage/inoperant', 'M', 'Retroviseurs'],
  ['3.4.1.a', 'Essuie-glace inoperant/manquant', 'M', 'Essuie-glace'],
  ['3.4.1.b', 'Balai essuie-glace defectueux', 'm', 'Essuie-glace'],
  ['3.5.1.a', 'Lave-glace inoperant', 'M', 'Essuie-glace'],
  ['4.1.1.a', 'Phare : lampe/source defectueuse (visibilite reduite)', 'M', 'Eclairage'],
  ['4.1.1.b', 'Phare : systeme projection defectueux', 'M', 'Eclairage'],
  ['4.1.1.c', 'Phare : mauvaise fixation', 'M', 'Eclairage'],
  ['4.1.2.a', 'Phare : orientation feu croisement hors limites', 'M', 'Eclairage'],
  ['4.1.4.a', 'Phare : couleur/position/intensite non conforme', 'M', 'Eclairage'],
  ['4.2.1.a', 'Feu position : source lumineuse defectueuse', 'M', 'Eclairage'],
  ['4.3.1.a', 'Feu stop : source defectueuse (visibilite reduite)', 'M', 'Eclairage'],
  ['4.3.2.a', 'Feu stop : commutateur non conforme', 'M', 'Eclairage'],
  ['4.4.1.a', 'Clignotant : source defectueuse (visibilite reduite)', 'M', 'Eclairage'],
  ['4.4.2.a', 'Clignotant : totalement inoperant', 'M', 'Eclairage'],
  ['4.5.1.a', 'Feu brouillard : source defectueuse', 'M', 'Eclairage'],
  ['4.5.3.a', 'Feu brouillard : commutateur inoperant', 'M', 'Eclairage'],
  ['4.7.1.b', 'Eclairage plaque : source defectueuse', 'M', 'Eclairage'],
  ['4.10.1.b', 'Cablage BT : isolation endommagee (court-circuit)', 'M', 'Electricite'],
  ['4.11.1.a', 'Cablage : mauvaise fixation (deconnexion)', 'M', 'Electricite'],
  ['4.11.1.b', 'Cablage fortement deteriore', 'M', 'Electricite'],
  ['4.11.1.c', 'Cablage : isolation endommagee (court-circuit)', 'M', 'Electricite'],
  ['4.13.1.a', 'Batterie : mauvaise fixation', 'M', 'Electricite'],
  ['4.13.1.b', 'Batterie : manque etancheite (substances dangereuses)', 'M', 'Electricite'],
  ['5.1.1.b', 'Essieu : mauvaise fixation', 'M', 'Essieux'],
  ['5.1.2.b', 'Porte-fusee : usure excessive pivot/bagues', 'M', 'Essieux'],
  ['5.1.3.a', 'Roulement roue : jeu excessif', 'M', 'Suspension'],
  ['5.2.1.a', 'Fixation roue : ecrou/goujon manquant/desserre', 'M', 'Roues'],
  ['5.2.1.b', 'Moyeu use ou endommage', 'M', 'Roues'],
  ['5.2.2.b', 'Jante : mauvais assemblage elements', 'M', 'Roues'],
  ['5.2.2.c', 'Jante gravement deformee ou usee', 'M', 'Roues'],
  ['5.2.3.a', 'Pneumatique : taille/capacite charge non conforme', 'M', 'Pneumatiques'],
  ['5.2.3.b', 'Pneumatiques differents sur meme essieu', 'M', 'Pneumatiques'],
  ['5.2.3.d', 'Pneumatique gravement endommage/entaille', 'M', 'Pneumatiques'],
  ['5.2.3.e', 'Pneumatique : indicateur usure sculptures atteint', 'M', 'Pneumatiques'],
  ['5.2.3.h', 'TPMS inoperant', 'M', 'Pneumatiques'],
  ['5.3.1.a', 'Ressort/stabilisateur : mauvaise attache', 'M', 'Suspension'],
  ['5.3.1.b', 'Ressort/stabilisateur endommage/fendu', 'M', 'Suspension'],
  ['5.3.1.c', 'Ressort/stabilisateur manquant', 'M', 'Suspension'],
  ['5.3.2.a', 'Amortisseur mal fixe', 'M', 'Suspension'],
  ['5.3.2.b', 'Amortisseur endommage/fuite/dysfonctionnement', 'M', 'Suspension'],
  ['5.3.3.a', 'Triangle/bras suspension : mauvaise attache', 'M', 'Suspension'],
  ['5.3.4.a', 'Rotule suspension : usure excessive', 'M', 'Suspension'],
  ['5.3.4.b', 'Rotule : capuchon antipoussiere manquant', 'M', 'Suspension'],
  ['6.1.1.a', 'Chassis : felure/deformation longeron/traverse', 'M', 'Chassis'],
  ['6.1.1.c', 'Chassis : corrosion excessive', 'M', 'Chassis'],
  ['6.1.2.a', 'Echappement : mauvaise fixation ou fuite', 'M', 'Echappement'],
  ['6.1.3.a', 'Reservoir/conduites carburant : mauvaise fixation', 'M', 'Carburant'],
  ['6.1.3.b', 'Fuite carburant ou bouchon manquant', 'M', 'Carburant'],
  ['6.1.3.c', 'Conduites carburant endommagees', 'M', 'Carburant'],
  ['6.1.7.b', 'Arbre transmission : usure excessive roulements', 'M', 'Transmission'],
  ['6.1.7.c', 'Arbre transmission : usure joints universels', 'M', 'Transmission'],
  ['6.1.7.d', 'Arbre transmission : raccords flexibles deteriores', 'M', 'Transmission'],
  ['6.2.1.a', 'Carrosserie : element mal fixe (risque blessures)', 'M', 'Carrosserie'],
  ['6.2.3.a', 'Portiere ne ouvre/ferme pas correctement', 'M', 'Carrosserie'],
  ['6.2.3.b', 'Portiere susceptible de ouvrir inopinement', 'M', 'Carrosserie'],
  ['6.2.5.a', 'Siege conducteur : structure defectueuse', 'M', 'Habitacle'],
  ['6.2.5.b', 'Siege conducteur : mecanisme reglage defaillant', 'M', 'Habitacle'],
  ['6.2.7.a', 'Commande conduite ne fonctionne pas correctement', 'M', 'Habitacle'],
  ['7.1.2.a', 'Ceinture securite obligatoire manquante', 'M', 'Securite passive'],
  ['7.1.2.b', 'Ceinture securite endommagee (coupure/distension)', 'M', 'Securite passive'],
  ['7.1.2.d', 'Boucle ceinture endommagee/inoperante', 'M', 'Securite passive'],
  ['7.1.5.a', 'Airbag manifestement manquant', 'M', 'Securite passive'],
  ['7.1.5.b', 'Airbag : defaillance via interface electronique', 'M', 'Securite passive'],
  ['7.1.5.c', 'Airbag manifestement inoperant', 'M', 'Securite passive'],
  ['7.1.6.a', 'Systeme retenue : defaillance', 'M', 'Securite passive'],
  ['7.7.1.a', 'Avertisseur sonore totalement inoperant', 'M', 'Equipements'],
  ['7.11.1.a', 'Kilometrage inferieur au precedent CT', 'm', 'Compteur'],
  ['7.11.1.b', 'Compteur kilometrique manifestement inoperant', 'M', 'Compteur'],
  ['7.12.1.e', 'ESP : defaillance signalee', 'M', 'ESP'],
  ['8.1.1.a', 'Bruit anormalement eleve', 'M', 'Echappement'],
  ['8.1.1.b', 'Silencieux : element desserre/manquant/modifie', 'M', 'Echappement'],
  ['8.2.12.a', 'Emissions gazeuses depassent valeur constructeur', 'M', 'Emissions'],
  ['8.2.12.b', 'Emissions gazeuses depassent valeur reglementaire', 'M', 'Emissions'],
  ['8.2.12.d', 'OBD : dysfonctionnement important releve', 'M', 'Emissions'],
  ['8.2.12.g', 'Fumee excessive', 'M', 'Emissions'],
  ['8.2.22.a', 'Opacite depasse valeur reception', 'M', 'Emissions'],
  ['8.4.1.a', 'Fuite excessive de liquide (environnement/securite)', 'M', 'Fuite liquide'],
  ['1.1.10.f', 'Temoin liquide freins allume', 'm', 'Freinage'],
  ['2.7.1.a', 'Ripage excessif', 'm', 'Direction'],
  ['3.2.1.a_m', 'Vitrage fissure hors zone balayage', 'm', 'Vitrage'],
  ['5.2.1.a_m', 'Un ecrou/goujon roue manquant', 'm', 'Roues'],
  ['5.2.3.e_m', 'Usure anormale pneumatique', 'm', 'Pneumatiques'],
  ['5.2.3.i', 'Pression pneumatique anormale', 'm', 'Pneumatiques'],
  ['5.3.2.d', 'Ecart amortissement droite/gauche', 'm', 'Suspension'],
  ['7.4.1.a', 'Triangle signalisation manquant', 'm', 'Equipements'],
];

const OTC_DB = Object.fromEntries(OTC_ROWS.map(([code, libelle, gravite, categorie]) => [
  code,
  { libelle, gravite, categorie },
]));

const KEYWORD_MAP = [
  [/LIQUIDE.{0,15}FREIN.{0,20}(FUITE|ABSENCE|NIVEAU|CONTAMIN|SEDIMENT)/i, '1.8.1.a'],
  [/FUITE.{0,15}LIQUIDE.{0,15}FREIN/i, '1.8.1.a'],
  [/NIVEAU.{0,10}LIQUIDE.{0,10}FREIN.{0,20}(MIN|INSUFFISANT)/i, '1.1.10.d'],
  [/GARNITURE.{0,20}(USURE|ENCRAS|HUILE|GRAISSE)/i, '1.1.13.b'],
  [/PLAQUETTE.{0,20}(USURE|ENCRAS|HUILE|GRAISSE)/i, '1.1.13.b'],
  [/DISQUE.{0,20}(USE|RAYE|FISSUR|ENCRAS)/i, '1.1.14.a'],
  [/TAMBOUR.{0,20}(USE|RAYE|FISSUR|ENCRAS)/i, '1.1.14.a'],
  [/FLEXIBLE.{0,20}(FRITE|POREUX|GONFLE|FISSUR|ENDOMMAG)/i, '1.1.12.e'],
  [/MAITRE.{0,10}CYLINDRE.{0,20}(DEFECTUEUX|FUITE|FISSUR)/i, '1.1.10.b'],
  [/ABS.{0,20}(DEFAILL|DYSFONCT|INOPER)/i, '1.6.1.a'],
  [/AMORTISSEUR.{0,20}(FUITE|ENDOMMAG|MAL.FIX|DEFECTUEUX)/i, '5.3.2.b'],
  [/RESSORT.{0,20}(CASSE|FISSUR|ENDOMMAG|MANQUANT)/i, '5.3.1.b'],
  [/PNEUMATIQUE.{0,20}(USURE|ENDOMMAG|PROFOND)/i, '5.2.3.e'],
  [/PNEU.{0,20}(USURE|ENDOMMAG|PROFOND|SCULPTURES)/i, '5.2.3.e'],
  [/JANTE.{0,20}(FISSUR|DEFORME|ENDOMMAG)/i, '5.2.2.c'],
  [/ROTULE.{0,20}(USURE|JEU|ENDOMMAG)/i, '5.3.4.a'],
  [/SILENT.?BLOC.{0,20}(USURE|ENDOMMAG|DEFECT)/i, '5.3.3.a'],
  [/CARDAN.{0,20}(USURE|JEU|ENDOMMAG|FISSUR)/i, '6.1.7.c'],
  [/TRANSMISSION.{0,20}(USURE|JEU|ENDOMMAG)/i, '6.1.7.c'],
  [/ECHAPPEMENT.{0,20}(FUITE|MAL.FIX|ENDOMMAG|PERCE)/i, '6.1.2.a'],
  [/SILENCIEUX.{0,20}(FUITE|MAL.FIX|ENDOMMAG|PERCE)/i, '6.1.2.a'],
  [/FUITE.{0,20}(HUILE|GAZ|CARBURANT|ESSENCE|GASOIL)/i, '8.4.1.a'],
  [/EMISSION.{0,20}(DEPASS|EXCESS|ELEVE)/i, '8.2.12.b'],
  [/OPACITE.{0,20}(DEPASS|EXCESS)/i, '8.2.22.a'],
  [/FUMEE.{0,20}(EXCESS|NOIR|BLEU)/i, '8.2.12.g'],
  [/OBD.{0,20}(DEFAILL|DYSFONCT|ERREUR)/i, '8.2.12.d'],
  [/CEINTURE.{0,20}(MANQUAN|ENDOMMAG|COUPURE)/i, '7.1.2.b'],
  [/AIRBAG.{0,20}(MANQUAN|INOPER|DEFAILL)/i, '7.1.5.c'],
  [/PHARE.{0,20}(DEFECTUEUX|MANQUANT|MAL.REGLE|INOPER)/i, '4.1.1.a'],
  [/FEU.{0,20}(STOP|FREIN).{0,20}(DEFECT|INOPER|MANQUANT)/i, '4.3.1.a'],
  [/CLIGNOTANT.{0,20}(DEFECT|INOPER|MANQUANT)/i, '4.4.2.a'],
  [/DIRECTION.{0,20}(JEU|USURE|DEFECT)/i, '2.3.1.a'],
  [/CREMAILLERE.{0,20}(JEU|USURE|FUITE|DEFECT)/i, '2.1.1.a'],
  [/PARE.?BRISE.{0,20}(FISSUR|FELE|IMPACT|ECLAT)/i, '3.2.1.a'],
  [/RETRO.{0,10}VISEUR.{0,20}(MANQUANT|ENDOMMAG|MAL.FIX)/i, '3.3.1.a'],
  [/ESSUIE.?GLACE.{0,20}(DEFECT|INOPER|MANQUANT)/i, '3.4.1.a'],
  [/CARROSSERIE.{0,20}(CORROSION|ROUILLE|PERCEE|ENDOMMAG)/i, '6.2.1.a'],
  [/CHASSIS.{0,20}(CORROSION|FISSUR|DEFORM)/i, '6.1.1.c'],
  [/KILOMETRAGE.{0,20}(INFERIEUR|RETROGRADE|BAISSE)/i, '7.11.1.a'],
  [/ESP.{0,20}(DEFAILL|DYSFONCT|INOPER)/i, '7.12.1.e'],
  [/RIPAGE.{0,20}(EXCESSIF|ANORMAL)/i, '2.7.1.a'],
  [/SERVODIRECTION.{0,20}(FUITE|DEFECT|INOPER)/i, '2.1.5.a'],
  [/DIRECTION.ASSISTEE.{0,20}(FUITE|DEFECT|INOPER)/i, '2.1.5.a'],
];

function normalizeOcr(text = '') {
  return String(text)
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function analyzeCtText(text = '') {
  const normalized = normalizeOcr(text);
  const isDefavorable = /DE.{0,3}FA.{0,3}VO.{0,3}RA.{0,3}BLE/.test(normalized)
    || /CONTRE.{0,3}VISITE/.test(normalized)
    || /RESULTAT\s*[:-]\s*D[EF]/.test(normalized)
    || /AVIS\s*[:-]\s*DEFAVORABLE/.test(normalized);
  const isSurveillance = /PRESCRIPTION.{0,5}SURVEILLANCE/.test(normalized)
    || /AVEC\s+PRESCRIPTION/.test(normalized)
    || /FAVORABLE\s+AVEC/.test(normalized)
    || (/SURV/.test(normalized) && /PRESCRIPTION/.test(normalized));
  const isFavorable = /(?<![A-Z])FAVORABLE(?![A-Z])/.test(normalized) && !isDefavorable;

  let verdict = 'inconnu';
  if (isDefavorable) verdict = 'defavorable';
  else if (isSurveillance) verdict = 'surveillance';
  else if (isFavorable) verdict = 'favorable';

  const detectedCodes = new Set();
  for (const code of Object.keys(OTC_DB)) {
    const codeParts = code.replace(/_.*$/, '').split('.');
    const pattern = codeParts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[.\\s]{0,3}');
    if (new RegExp(pattern, 'i').test(normalized)) detectedCodes.add(code);
  }
  for (const [pattern, code] of KEYWORD_MAP) {
    if (pattern.test(normalized)) detectedCodes.add(code);
  }

  const defects = { M: [], m: [], C: [] };
  for (const code of detectedCodes) {
    const entry = OTC_DB[code];
    if (!entry) continue;
    defects[entry.gravite].push({
      code,
      label: `[${code.replace(/_.*$/, '')}] ${entry.libelle}`,
      categorie: entry.categorie,
    });
  }

  const sortDefects = (items) => items.sort((a, b) => (
    a.categorie.localeCompare(b.categorie) || a.code.localeCompare(b.code)
  ));
  const groupByCategory = (items) => {
    const groups = {};
    for (const item of items) {
      if (!groups[item.categorie]) groups[item.categorie] = [];
      groups[item.categorie].push(item.label);
    }
    return groups;
  };

  const major = sortDefects(defects.M);
  const minor = sortDefects(defects.m);
  const critical = sortDefects(defects.C);
  return {
    verdict,
    majeures: major.map((item) => item.label),
    mineures: minor.map((item) => item.label),
    critiques: critical.map((item) => item.label),
    majeures_groupes: groupByCategory(major),
    mineures_groupes: groupByCategory(minor),
    nb_codes_detectes: detectedCodes.size,
    aucune: !major.length && !minor.length && /AUCUNE.{0,10}DEFAILLANCE|SANS.{0,10}DEFAILLANCE|RAS\b|NEANT/.test(normalized),
    texte_brut: String(text),
  };
}

function isPdfBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-';
}

async function runCommand(command, args, timeoutMs) {
  return execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
  });
}

async function extractCtText(pdfBuffer, options = {}) {
  if (!isPdfBuffer(pdfBuffer)) throw new Error('Le document CT recu ne commence pas par %PDF-.');

  const maxPages = Math.max(1, Number(options.maxPages || process.env.CT_MAX_PAGES || 4));
  const minNativeChars = Math.max(1, Number(options.minNativeChars || process.env.CT_MIN_TEXT_CHARS || 80));
  const dpi = Math.max(100, Number(options.dpi || process.env.CT_OCR_DPI || 200));
  const timeoutMs = Math.max(10_000, Number(options.timeoutMs || process.env.CT_OCR_TIMEOUT_MS || 120_000));
  const pdfToText = process.env.PDFTOTEXT_BIN || 'pdftotext';
  const pdfToPpm = process.env.PDFTOPPM_BIN || 'pdftoppm';
  const tesseract = process.env.TESSERACT_BIN || 'tesseract';
  const language = process.env.TESSERACT_LANG || 'fra';
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alcopa-ct-'));
  const pdfPath = path.join(tempDir, 'ct.pdf');

  try {
    await fs.writeFile(pdfPath, pdfBuffer);
    let nativeText = '';
    try {
      const result = await runCommand(pdfToText, ['-f', '1', '-l', String(maxPages), '-layout', pdfPath, '-'], timeoutMs);
      nativeText = result.stdout.trim();
    } catch {
      nativeText = '';
    }

    if (nativeText.length >= minNativeChars) {
      return { text: nativeText, source: 'pdf-text', pagesProcessed: null };
    }

    const pagePrefix = path.join(tempDir, 'page');
    try {
      await runCommand(pdfToPpm, [
        '-f', '1', '-l', String(maxPages), '-r', String(dpi), '-png', pdfPath, pagePrefix,
      ], timeoutMs);
    } catch (error) {
      throw new Error(`Rendu PDF impossible avec pdftoppm: ${error.message}`);
    }

    const pageFiles = (await fs.readdir(tempDir))
      .filter((file) => /^page-\d+\.png$/i.test(file))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!pageFiles.length) throw new Error('Aucune page image produite pour le CT.');

    const pageTexts = [];
    for (const pageFile of pageFiles) {
      try {
        const result = await runCommand(tesseract, [
          path.join(tempDir, pageFile), 'stdout', '-l', language, '--psm', '6',
        ], timeoutMs);
        pageTexts.push(result.stdout.trim());
      } catch (error) {
        throw new Error(`OCR Tesseract indisponible ou en echec: ${error.message}`);
      }
    }
    return {
      text: [nativeText, ...pageTexts].filter(Boolean).join('\n\n'),
      source: 'ocr',
      pagesProcessed: pageFiles.length,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export { analyzeCtText, extractCtText, isPdfBuffer, normalizeOcr };
