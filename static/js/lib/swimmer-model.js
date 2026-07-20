// Modelo compartido de nadador: normaliza edad/nivel y mergea listas sin
// duplicar por id. Mismo shape que usa la página Nadadores y el onboarding.
// Funciones puras (sin DOM ni storage) para poder testearlas aisladas.

export const LEVELS = ['principiante', 'intermedio', 'avanzado'];

/**
 * Normaliza un nadador al shape canónico: edad inválida -> null, nivel
 * desconocido -> 'intermedio'. No genera id ni fecha (los pasa el caller) para
 * mantener la función pura y determinista.
 * @param {{id?:string,name:string,age?:number,level?:string,createdAt?:string}} data
 * @returns {{id:string,name:string,age:number|null,level:string,createdAt:string}}
 */
export function normalizeSwimmer(data) {
  const age = Number(data.age);
  return {
    id: data.id,
    name: data.name,
    age: Number.isFinite(age) && age > 0 ? age : null,
    level: LEVELS.includes(data.level) ? data.level : 'intermedio',
    createdAt: data.createdAt,
  };
}

/**
 * Devuelve `saved` más los de `session` cuyo id no exista ya (dedup por id).
 * No muta las entradas.
 * @param {Object[]} saved   nadadores ya persistidos
 * @param {Object[]} session nadadores elegidos en esta sesión
 * @returns {{merged:Object[],added:Object[]}}
 */
export function mergeSwimmers(saved, session) {
  const ids = new Set(saved.map((s) => s.id));
  const added = session.filter((s) => !ids.has(s.id));
  return { merged: saved.concat(added), added };
}
