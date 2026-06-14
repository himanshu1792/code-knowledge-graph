import React from 'react';

export default function OrdersPage() {
  React.useEffect(() => {
    fetch('/api/orders');
    fetch('/api/users', { method: 'POST', body: '{}' });
  }, []);
  return <div>Orders</div>;
}
