export const iconPath = (w) => `images/weapon_${w.name.toLowerCase().replace(/[:']/g, '').replace(/ /g, '_')}.png`;
export const typeIconPath = (type) => `images/weaponcategory_${type.toLowerCase().replace(/ /g, '_')}.png`;
