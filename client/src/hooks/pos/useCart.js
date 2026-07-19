import { useState, useMemo } from 'react';
import { useData } from '../../lib/data.jsx';

// Cart state, per-cup add/update/remove, promo code, and the subtotal/
// discount/total derived from the cart. `addToCart` takes an
// already-computed line (drink/childId/childObj/sweet/container/addonRows/
// addonsPrice/singleCup/qty/isFree/promotionId) — customizer logic
// (canRedeemFree, per-cup price math) stays in POS.jsx; this hook only owns
// the cart array itself.
export function useCart() {
  const { pushToast } = useData();
  const [cart, setCart] = useState([]);
  const [promoCode, setPromoCode] = useState('');
  const [appliedDiscount, setAppliedDiscount] = useState({ code: '', type: 'none', value: 0 });

  const addToCart = ({ drink, childId, childObj, sweet, container, addonRows, addonsPrice, singleCup, qty, isFree, promotionId }) => {
    setCart(prev => {
      // Free cups are never merged into an existing line — each is its own
      // 1-cup line so the per-customer credit count (and comp count) stays exact.
      const existingIdx = !isFree ? prev.findIndex(item =>
        !item.isFree &&
        item.drink.id === drink.id &&
        item.childId === childId &&
        item.sweet === sweet &&
        item.container === container &&
        JSON.stringify(item.addonRows) === JSON.stringify(addonRows)
      ) : -1;

      if (existingIdx > -1) {
        const next = [...prev];
        next[existingIdx] = {
          ...next[existingIdx],
          qty: next[existingIdx].qty + qty,
          totalPrice: next[existingIdx].singleCup * (next[existingIdx].qty + qty)
        };
        return next;
      } else {
        return [...prev, {
          id: Math.random().toString(36).substring(2, 11),
          drink, childId, childObj, sweet, container, addonRows, addonsPrice,
          singleCup, qty, totalPrice: singleCup * qty, isFree, promotionId
        }];
      }
    });
  };

  // Edit/Modify item quantity directly in the Cart list
  const updateCartItemQty = (id, increment) => {
    setCart(prev => prev.map(item => {
      if (item.id === id && !item.isFree) {
        const nextQty = Math.max(1, item.qty + (increment ? 1 : -1));
        return {
          ...item,
          qty: nextQty,
          totalPrice: item.singleCup * nextQty
        };
      }
      return item;
    }));
  };

  const removeCartItem = (id) => {
    setCart(prev => prev.filter(item => item.id !== id));
    pushToast('Item removed.', 'info');
  };

  // Applying promo codes
  const handleApplyPromo = () => {
    const code = promoCode.trim().toUpperCase();
    if (!code) {
      setAppliedDiscount({ code: '', type: 'none', value: 0 });
      return;
    }

    if (code === 'SAGE10' || code === 'PROMO10') {
      setAppliedDiscount({ code, type: 'percent', value: 10 });
      pushToast('10% discount code applied.', 'success');
    } else if (code === 'WELCOME') {
      setAppliedDiscount({ code, type: 'flat', value: 50 });
      pushToast('฿50 flat discount applied.', 'success');
    } else {
      const num = parseFloat(code);
      if (!isNaN(num) && num > 0) {
        setAppliedDiscount({ code: 'MANUAL', type: 'flat', value: num });
        pushToast(`฿${num} discount applied.`, 'success');
      } else {
        pushToast('Invalid promo code.', 'warning');
      }
    }
  };

  // Cart calculation aggregates
  const cartSubtotal = useMemo(() => {
    return cart.reduce((sum, item) => sum + item.totalPrice, 0);
  }, [cart]);

  const discountAmount = useMemo(() => {
    if (appliedDiscount.type === 'percent') {
      return Math.round((cartSubtotal * appliedDiscount.value) / 100);
    } else if (appliedDiscount.type === 'flat') {
      return Math.min(cartSubtotal, appliedDiscount.value);
    }
    return 0;
  }, [cartSubtotal, appliedDiscount]);

  const cartTotal = useMemo(() => {
    return cartSubtotal - discountAmount;
  }, [cartSubtotal, discountAmount]);

  // Clears the cart + promo state (used after a successful checkout).
  const resetCart = () => {
    setCart([]);
    setPromoCode('');
    setAppliedDiscount({ code: '', type: 'none', value: 0 });
  };

  return {
    cart, setCart, addToCart, updateCartItemQty, removeCartItem,
    promoCode, setPromoCode, appliedDiscount, handleApplyPromo,
    cartSubtotal, discountAmount, cartTotal, resetCart
  };
}
