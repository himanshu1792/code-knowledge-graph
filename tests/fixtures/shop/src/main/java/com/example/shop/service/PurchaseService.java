package com.example.shop.service;

import com.example.shop.domain.Purchase;
import com.example.shop.repository.PurchaseRepository;
import org.springframework.stereotype.Service;
import java.util.List;

@Service
public class PurchaseService {

    private final PurchaseRepository repository;

    public PurchaseService(PurchaseRepository repository) {
        this.repository = repository;
    }

    public List<Purchase> forCustomer(Long customerId) {
        return repository.findByCustomerId(customerId);
    }
}
