/**
 * Seed 50 default lunch dishes into MenuCatalog (idempotent by name).
 */
const DEFAULT_DISHES = [
  // mains (20)
  { name: 'Butter Chicken', category: 'main', emoji: '🍗', description: 'Creamy tomato gravy' },
  { name: 'Chicken Biryani', category: 'main', emoji: '🍚', description: 'Hyderabadi style' },
  { name: 'Mutton Rogan Josh', category: 'main', emoji: '🍖', description: 'Kashmiri spices' },
  { name: 'Fish Curry', category: 'main', emoji: '🐟', description: 'Coastal coconut base' },
  { name: 'Egg Curry', category: 'main', emoji: '🥚', description: 'Onion-tomato masala' },
  { name: 'Paneer Butter Masala', category: 'main', emoji: '🧀', description: 'Cottage cheese curry' },
  { name: 'Dal Makhani', category: 'main', emoji: '🥣', description: 'Slow-cooked black lentils' },
  { name: 'Chole Masala', category: 'main', emoji: '🫘', description: 'Punjabi chickpeas' },
  { name: 'Rajma Chawal', category: 'main', emoji: '🍛', description: 'Kidney beans with rice' },
  { name: 'Veg Pulao', category: 'main', emoji: '🍚', description: 'Fragrant basmati rice' },
  { name: 'Chicken Fried Rice', category: 'main', emoji: '🥡', description: 'Indo-Chinese' },
  { name: 'Veg Hakka Noodles', category: 'main', emoji: '🍜', description: 'Stir-fried noodles' },
  { name: 'Pasta Arrabbiata', category: 'main', emoji: '🍝', description: 'Spicy tomato pasta' },
  { name: 'Grilled Chicken', category: 'main', emoji: '🥩', description: 'Herb marinated' },
  { name: 'Keema Matar', category: 'main', emoji: '🥘', description: 'Minced meat with peas' },
  { name: 'Kadhi Pakora', category: 'main', emoji: '🍲', description: 'Yogurt curry with fritters' },
  { name: 'Sambar Rice', category: 'main', emoji: '🍚', description: 'South Indian thali style' },
  { name: 'Chicken Korma', category: 'main', emoji: '🍗', description: 'Mild cashew gravy' },
  { name: 'Palak Paneer', category: 'main', emoji: '🥬', description: 'Spinach and paneer' },
  { name: 'Aloo Gobi', category: 'main', emoji: '🥔', description: 'Potato cauliflower dry' },
  // sides (15)
  { name: 'Jeera Rice', category: 'side', emoji: '🍚', description: 'Cumin tempered rice' },
  { name: 'Steamed Rice', category: 'side', emoji: '🍚', description: 'Plain basmati' },
  { name: 'Butter Naan', category: 'side', emoji: '🫓', description: 'Tandoor bread' },
  { name: 'Tawa Roti', category: 'side', emoji: '🫓', description: 'Whole wheat flatbread' },
  { name: 'Missi Roti', category: 'side', emoji: '🫓', description: 'Gram flour roti' },
  { name: 'Garden Salad', category: 'side', emoji: '🥗', description: 'Fresh greens' },
  { name: 'Cucumber Raita', category: 'side', emoji: '🥒', description: 'Yogurt side' },
  { name: 'Onion Salad', category: 'side', emoji: '🧅', description: 'Lemon and chili' },
  { name: 'Papad', category: 'side', emoji: '🍘', description: 'Crispy lentil wafer' },
  { name: 'Pickle Mix', category: 'side', emoji: '🫙', description: 'Assorted achar' },
  { name: 'French Fries', category: 'side', emoji: '🍟', description: 'Salted potato fries' },
  { name: 'Masala Corn', category: 'side', emoji: '🌽', description: 'Buttered sweet corn' },
  { name: 'Soup of the Day', category: 'side', emoji: '🥣', description: 'Chef special' },
  { name: 'Green Chutney', category: 'side', emoji: '🌿', description: 'Coriander mint' },
  { name: 'Boiled Eggs', category: 'side', emoji: '🥚', description: 'Salt and pepper' },
  // desserts (8)
  { name: 'Gulab Jamun', category: 'dessert', emoji: '🍡', description: 'Warm syrup balls' },
  { name: 'Rasgulla', category: 'dessert', emoji: '⚪', description: 'Soft cottage cheese balls' },
  { name: 'Kheer', category: 'dessert', emoji: '🍮', description: 'Rice pudding' },
  { name: 'Ice Cream Scoop', category: 'dessert', emoji: '🍨', description: 'Vanilla / chocolate' },
  { name: 'Fruit Custard', category: 'dessert', emoji: '🍓', description: 'Seasonal fruit' },
  { name: 'Chocolate Brownie', category: 'dessert', emoji: '🍫', description: 'Walnut brownie' },
  { name: 'Jalebi', category: 'dessert', emoji: '🌀', description: 'Crispy saffron swirls' },
  { name: 'Moong Dal Halwa', category: 'dessert', emoji: '🟡', description: 'Rich lentil dessert' },
  // vegan (7)
  { name: 'Vegan Buddha Bowl', category: 'vegan', emoji: '🥗', description: 'Quinoa, greens, tahini' },
  { name: 'Tofu Stir Fry', category: 'vegan', emoji: '🥦', description: 'Soy and veggies' },
  { name: 'Vegan Dal Tadka', category: 'vegan', emoji: '🥣', description: 'Oil-tempered lentils' },
  { name: 'Chickpea Salad', category: 'vegan', emoji: '🥗', description: 'Lemon herb dressing' },
  { name: 'Vegan Pulao', category: 'vegan', emoji: '🍚', description: 'No ghee vegetable rice' },
  { name: 'Grilled Veggies', category: 'vegan', emoji: '🍆', description: 'Zucchini, peppers, mushrooms' },
  { name: 'Avocado Toast Box', category: 'vegan', emoji: '🥑', description: 'Sourdough with avocado' },
];

async function ensureDefaultDishes(MenuCatalog) {
  const existing = await MenuCatalog.countDocuments({ isActive: true });
  if (existing >= 50) {
    return { seeded: 0, total: existing };
  }

  let seeded = 0;
  for (const dish of DEFAULT_DISHES) {
    const found = await MenuCatalog.findOne({ name: dish.name });
    if (found) {
      if (!found.isActive) {
        found.isActive = true;
        await found.save();
      }
      continue;
    }
    await MenuCatalog.create({
      ...dish,
      createdBy: 'System seed',
      isActive: true,
    });
    seeded += 1;
  }

  const total = await MenuCatalog.countDocuments({ isActive: true });
  return { seeded, total };
}

module.exports = { DEFAULT_DISHES, ensureDefaultDishes };
